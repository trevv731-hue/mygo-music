// NetEase Cloud Music as a MyGo Music source.
//
// The plugin talks to NetEase the way its desktop client does: the eapi
// encrypts a request as AES-128-ECB over the path, the JSON body and their
// MD5, and the login, playback and edit calls go through it. Public pages and
// search use the web API. The app keeps the interface; this file only answers
// what the source interfaces ask for.
//
// This is an unofficial client. It uses an account the listener owns, and
// NetEase may change or refuse any of these endpoints at any time.

const BASE = "https://music.163.com";
const EAPI_BASE = "https://interfacepc.music.163.com";
const EAPI_KEY = "e82ckenh8dichen8";
const EAPI_UA = "NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)";
const WEB_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.0 Safari/605.1.15";

const t = (text) => host.t(text);

// The levels NetEase serves, from the lowest. The app asks for standard, high
// or lossless; maxQuality in the settings caps what is asked of NetEase.
const NET_LEVELS = ["standard", "higher", "exhigh", "lossless", "hires"];

const PAGE_SIZE = 30;
const LIKED_PAGE = 100;

// ---------------------------------------------------------------------------
// State kept between calls, and in the plugin's storage between runs.

let cookies = host.storage.get("cookies") ?? {};
let uid = String(host.storage.get("uid") ?? "");
let accountCache = host.storage.get("account") ?? null;
let ignoreCookieSetting = Boolean(host.storage.get("ignoreCookieSetting"));

let likedCache = null;
let likedAt = 0;
let savedAlbumCache = null;
let savedAlbumAt = 0;
// Episodes play as their audio's song ID; their likes and comments are the
// episode's, by the program ID the show page taught us.
const programByTrack = new Map();

function saveCookies() {
  host.storage.set("cookies", cookies);
}

function clearAuth() {
  cookies = {};
  uid = "";
  accountCache = null;
  likedCache = null;
  likedAt = 0;
  savedAlbumCache = null;
  savedAlbumAt = 0;
  userPlaylistsCache = null;
  userPlaylistsAt = 0;
  programByTrack.clear();
  host.storage.remove("cookies");
  host.storage.remove("uid");
  host.storage.remove("account");
}

function hasSession() {
  return Boolean(cookies.MUSIC_U || cookies.MUSIC_A);
}

function csrf() {
  return cookies.__csrf || "";
}

function cookieHeader() {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function parseCookieString(raw) {
  for (const part of String(raw).split(";")) {
    const piece = part.trim();
    const eq = piece.indexOf("=");
    if (eq <= 0) continue;
    const name = piece.slice(0, eq).trim();
    const value = piece.slice(eq + 1).trim();
    if (!name || !value) continue;
    if (/max-age=0/i.test(piece) || /expires=thu, 01 jan 1970/i.test(piece)) {
      delete cookies[name];
    } else {
      cookies[name] = value;
    }
  }
  saveCookies();
}

function importCookieSetting() {
  // A cookie typed into the settings is a way in for a fresh sign-in. Once a
  // session is stored, it must not overwrite what QR or page sign-in got:
  // the setting may be old and the stored cookie new. setSetting replaces the
  // session when the listener edits the field, and signing out stops the old
  // field from signing them in again.
  if (ignoreCookieSetting || hasSession()) return;
  const raw = (host.setting("cookie") || "").trim();
  if (raw) parseCookieString(raw);
}

function absorbCookies(res) {
  let list = [];
  try {
    if (typeof res.headers.getSetCookie === "function") {
      const got = res.headers.getSetCookie();
      if (Array.isArray(got)) list = got;
      else if (got) list = [got];
    }
  } catch {
    // Older runtimes only expose the combined header.
  }
  if (list.length === 0) {
    const one = res.headers.get("set-cookie");
    if (one) list = [one];
  }
  if (list.length === 0) return;
  // Some runtimes join cookies with commas, in one header: split before a
  // name= pair, not inside an Expires date.
  const parts = [];
  for (const header of list) {
    parts.push(
      ...String(header).split(/,(?=\s*[A-Za-z0-9!#$%&'*+.^_`|~-]+=)/)
    );
  }
  for (const header of parts) {
    const semi = header.indexOf(";");
    const pair = semi >= 0 ? header.slice(0, semi) : header;
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) continue;
    if (/max-age=0/i.test(header) || /expires=thu, 01 jan 1970/i.test(header)) {
      delete cookies[name];
    } else {
      cookies[name] = value;
    }
  }
  saveCookies();
}

// ---------------------------------------------------------------------------
// Small helpers.

function fail(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function textOf(value) {
  return value == null ? "" : String(value);
}

function plainText(value) {
  return textOf(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dateOf(ms) {
  const n = Number(ms);
  if (!n || n <= 0) return "";
  const date = new Date(n);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

// The app fills {size} in with how many pixels across it shows a picture.
function sized(url) {
  const raw = textOf(url).trim();
  if (!raw) return "";
  let pic = raw.replace(/^http:\/\//, "https://");
  if (pic.includes("{size}") || pic.includes("param=")) return pic;
  return pic + (pic.includes("?") ? "&" : "?") + "param={size}y{size}";
}

function artistOf(raw) {
  if (!raw) return null;
  const id = raw.id ?? raw.userId ?? "";
  const name = raw.name ?? raw.nickname ?? "";
  if (!name && id === "") return null;
  return {
    id: textOf(id),
    name: textOf(name),
    imageUrl: sized(raw.img1v1Url || raw.picUrl || raw.avatarUrl),
  };
}

function albumOf(raw) {
  const al = raw || {};
  const artists = (al.artists || al.ar || (al.artist ? [al.artist] : []))
    .map(artistOf)
    .filter(Boolean);
  const album = {
    id: textOf(al.id ?? ""),
    name: textOf(al.name ?? ""),
    imageUrl: sized(al.picUrl || al.coverImgUrl || al.blurPicUrl),
    artists,
    released: dateOf(al.publishTime),
  };
  if (savedAlbumCache && album.id && savedAlbumCache.has(album.id)) {
    album.saved = true;
  }
  return album;
}

function unavailable(raw) {
  const p = raw && raw.privilege;
  if (p && typeof p === "object") {
    if (typeof p.st === "number" && p.st < 0) return true;
    if (
      typeof p.pl === "number" &&
      p.pl <= 0 &&
      (raw.fee === 1 || raw.fee === 4)
    ) {
      return true;
    }
  }
  return false;
}

function trackOf(raw) {
  const song = raw || {};
  const id = song.id ?? song.songId ?? "";
  const artists = (song.ar || song.artists || [])
    .map(artistOf)
    .filter(Boolean);
  const track = {
    id: textOf(id),
    name: textOf(song.name ?? song.songName ?? ""),
    artists,
    album: albumOf(song.al || song.album || {}),
    duration: Number(song.dt ?? song.duration ?? 0),
    url: id === "" ? "" : `${BASE}/song?id=${textOf(id)}`,
  };
  if (unavailable(song)) track.unavailable = true;
  if (song.programId) {
    track.showId = textOf(song.podcastId ?? "");
    track.description = plainText(song.description);
    track.published = dateOf(song.createTime);
    track.url = `${BASE}/program?id=${textOf(song.programId)}`;
  }
  return track;
}

function playlistOf(raw, tracks) {
  const p = raw || {};
  const creatorId = textOf(p.creator?.userId ?? p.userId ?? "");
  const mine =
    p.specialType === 5 ||
    (uid !== "" && creatorId !== "" && creatorId === uid && !p.subscribed);
  const list = {
    id: textOf(p.id ?? ""),
    name: textOf(p.name ?? ""),
    imageUrl: sized(p.coverImgUrl || p.picUrl || p.coverImageUrl),
    description: plainText(p.description),
    owner: textOf(p.creator?.nickname ?? ""),
    trackCount: Number(p.trackCount ?? p.tracks?.length ?? 0),
    mine,
    saved: Boolean(p.subscribed),
    fixed: p.specialType === 5,
  };
  if (tracks) list.tracks = tracks;
  return list;
}

function showOf(raw) {
  const p = raw || {};
  return {
    id: textOf(p.id ?? p.radioId ?? ""),
    name: textOf(p.name ?? ""),
    imageUrl: sized(p.picUrl || p.coverUrl),
    description: plainText(p.desc ?? p.description),
    publisher: textOf(p.dj?.nickname ?? p.dj?.name ?? ""),
    publisherPage: "",
    episodeCount: Number(p.programCount ?? 0),
    subscribed: Boolean(p.subed ?? p.subscribed),
  };
}

function episodeOf(program, podcast) {
  const p = program || {};
  const pod = podcast || {};
  const main = p.mainSong || {};
  const id = main.id ?? p.mainSongId ?? "";
  if (textOf(id) === "") return null;
  const cover = p.coverUrl || pod.picUrl;
  const dj = pod.dj || {};
  const track = {
    id: textOf(id),
    name: textOf(p.name ?? main.name ?? ""),
    artists: [
      {
        id: textOf(dj.userId ?? pod.id ?? ""),
        name: textOf(dj.nickname ?? pod.name ?? ""),
        imageUrl: sized(dj.avatarUrl || pod.picUrl),
      },
    ],
    album: {
      id: textOf(pod.id ?? ""),
      name: textOf(pod.name ?? ""),
      imageUrl: sized(cover),
    },
    duration: Number(p.duration ?? main.duration ?? 0),
    showId: textOf(pod.id ?? ""),
    description: plainText(p.description),
    published: dateOf(p.createTime),
    url: `${BASE}/program?id=${textOf(p.id ?? "")}`,
  };
  if (p.id !== undefined) programByTrack.set(track.id, textOf(p.id));
  return track;
}

function commentOf(raw) {
  const c = raw || {};
  return {
    id: textOf(c.commentId ?? c.id ?? ""),
    author: textOf(c.user?.nickname ?? ""),
    avatarUrl: sized(c.user?.avatarUrl),
    text: textOf(c.content ?? ""),
    time: Number(c.time ?? 0),
    likes: Number(c.likedCount ?? 0),
    liked: Boolean(c.liked),
  };
}

function codeError(path, data) {
  const body = data || {};
  const code = Number(body.code);
  const message =
    textOf(body.message || body.msg) ||
    `NetEase answered code ${Number.isFinite(code) ? code : "?"}`;
  if (code === 301 || code === -2) return fail("signIn", message);
  if (code === -460) return fail("unavailable", message);
  return new Error(`${path}: ${message}`);
}

// ---------------------------------------------------------------------------
// The web API speaks JSON at music.163.com, with the session cookie.

async function request(path, options = {}) {
  const { query, method = "GET", form, check = true } = options;
  const url = new URL(BASE + path);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, textOf(value));
      }
    }
  }
  const headers = {
    "User-Agent": WEB_UA,
    Referer: BASE + "/",
    Accept: "application/json, text/plain, */*",
  };
  const cookie = cookieHeader();
  if (cookie) headers.Cookie = cookie;
  let body;
  if (method === "POST") {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(form || {})) {
      if (value !== undefined && value !== null) {
        params.set(key, textOf(value));
      }
    }
    if (csrf() && !params.has("csrf_token")) params.set("csrf_token", csrf());
    body = params.toString();
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  const res = await fetch(url.toString(), { method, headers, body });
  absorbCookies(res);
  if (res.status >= 400) {
    throw new Error(`${path}: HTTP ${res.status}`);
  }
  const raw = await res.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`${path}: NetEase answered something else`);
  }
  if (check && typeof data.code === "number" && data.code !== 200) {
    throw codeError(path, data);
  }
  return data;
}

function get(path, query) {
  return request(path, { query });
}

function post(path, form) {
  return request(path, { method: "POST", form });
}

async function eapi(path, data) {
  const header = {
    osver: "Microsoft-Windows-10-Professional-build-19045-64bit",
    deviceId: deviceId(),
    os: "pc",
    appver: "3.1.17.204416",
    versioncode: "140",
    mobilename: "",
    buildver: String(Math.floor(Date.now() / 1000)),
    resolution: "1920x1080",
    channel: "netease",
    requestId: `${Date.now()}_${String(Math.floor(Math.random() * 1000)).padStart(4, "0")}`,
    __csrf: csrf(),
  };
  for (const name of ["MUSIC_U", "MUSIC_A", "NMTID", "__csrf"]) {
    if (cookies[name]) header[name] = cookies[name];
  }
  const payload = { ...(data || {}), header, e_r: false };
  const body = JSON.stringify(payload);
  const digest = host.crypto.md5(
    "nobody" + path + "use" + body + "md5forencrypt"
  );
  const plain = path + "-36cd479b6b5-" + body + "-36cd479b6b5-" + digest;
  const params = host.crypto.aesEcbEncrypt(EAPI_KEY, plain).toUpperCase();
  const cookiePairs = Object.entries(header).map(
    ([name, value]) =>
      encodeURIComponent(name) + "=" + encodeURIComponent(value)
  );
  const res = await fetch(
    EAPI_BASE + "/eapi/" + path.replace(/^\/api\//, ""),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": EAPI_UA,
        Referer: BASE + "/",
        Cookie: cookiePairs.join("; "),
      },
      body: new URLSearchParams({ params }).toString(),
    }
  );
  absorbCookies(res);
  if (res.status >= 400) {
    throw new Error(`${path}: HTTP ${res.status}`);
  }
  const raw = await res.text();
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`${path}: NetEase answered something else`);
  }
}

async function eapiOk(path, data) {
  const answer = await eapi(path, data);
  if (typeof answer.code === "number" && answer.code !== 200) {
    throw codeError(path, answer);
  }
  return answer;
}

// ---------------------------------------------------------------------------
// The web API's encrypted requests, for what the eapi refuses or cannot reach.
// It is AES-128-CBC in two layers and RSA, as the web player sends them.

const WEAPI_PRESET = "0CoJUm6Qyw8W8jud";
const WEAPI_IV = "0102030405060708";
const WEAPI_MODULUS =
  "00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725" +
  "152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e031" +
  "2ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b" +
  "424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0" +
  "a22b8e7";
const WEAPI_EXPONENT = 0x10001n;
const WEAPI_BASE62 =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function aesMul(a, b) {
  let p = 0;
  for (let i = 0; i < 8; i += 1) {
    if (b & 1) p ^= a;
    const high = a & 0x80;
    a = (a << 1) & 0xff;
    if (high) a ^= 0x1b;
    b >>= 1;
  }
  return p & 0xff;
}

function aesPow(a, n) {
  let r = 1;
  while (n > 0) {
    if (n & 1) r = aesMul(r, a);
    a = aesMul(a, a);
    n >>= 1;
  }
  return r;
}

function rotl8(x, n) {
  return ((x << n) | (x >> (8 - n))) & 0xff;
}

const AES_SBOX = new Uint8Array(256);
for (let x = 0; x < 256; x += 1) {
  const inv = x ? aesPow(x, 254) : 0;
  AES_SBOX[x] =
    inv ^ rotl8(inv, 1) ^ rotl8(inv, 2) ^ rotl8(inv, 3) ^ rotl8(inv, 4) ^ 0x63;
}

const AES_RCON = [];
{
  let r = 1;
  for (let i = 0; i < 10; i += 1) {
    AES_RCON.push(r);
    r = aesMul(r, 2);
  }
}

function aesExpandKey(key) {
  const w = [];
  for (let i = 0; i < 4; i += 1) {
    w.push([key[4 * i], key[4 * i + 1], key[4 * i + 2], key[4 * i + 3]]);
  }
  for (let i = 4; i < 44; i += 1) {
    let t = w[i - 1].slice();
    if (i % 4 === 0) {
      t = [t[1], t[2], t[3], t[0]].map((b) => AES_SBOX[b]);
      t[0] ^= AES_RCON[i / 4 - 1];
    }
    w.push([
      w[i - 4][0] ^ t[0],
      w[i - 4][1] ^ t[1],
      w[i - 4][2] ^ t[2],
      w[i - 4][3] ^ t[3],
    ]);
  }
  return w;
}

function aesEncryptBlock(block, w) {
  const st = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  for (let c = 0; c < 4; c += 1) {
    for (let r = 0; r < 4; r += 1) st[r][c] = block[r + 4 * c];
  }
  const addKey = (round) => {
    for (let c = 0; c < 4; c += 1) {
      const k = w[4 * round + c];
      for (let r = 0; r < 4; r += 1) st[r][c] ^= k[r];
    }
  };
  addKey(0);
  for (let round = 1; round <= 10; round += 1) {
    for (let r = 0; r < 4; r += 1) {
      for (let c = 0; c < 4; c += 1) st[r][c] = AES_SBOX[st[r][c]];
    }
    for (let r = 1; r < 4; r += 1) {
      const row = st[r].slice();
      for (let c = 0; c < 4; c += 1) st[r][c] = row[(c + r) % 4];
    }
    if (round !== 10) {
      for (let c = 0; c < 4; c += 1) {
        const a = [st[0][c], st[1][c], st[2][c], st[3][c]];
        st[0][c] = aesMul(a[0], 2) ^ aesMul(a[1], 3) ^ a[2] ^ a[3];
        st[1][c] = a[0] ^ aesMul(a[1], 2) ^ aesMul(a[2], 3) ^ a[3];
        st[2][c] = a[0] ^ a[1] ^ aesMul(a[2], 2) ^ aesMul(a[3], 3);
        st[3][c] = aesMul(a[0], 3) ^ a[1] ^ a[2] ^ aesMul(a[3], 2);
      }
    }
    addKey(round);
  }
  const out = new Uint8Array(16);
  for (let c = 0; c < 4; c += 1) {
    for (let r = 0; r < 4; r += 1) out[r + 4 * c] = st[r][c];
  }
  return out;
}

function utf8Bytes(text) {
  const out = [];
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    } else if (cp < 0x10000) {
      out.push(
        0xe0 | (cp >> 12),
        0x80 | ((cp >> 6) & 63),
        0x80 | (cp & 63)
      );
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 63),
        0x80 | ((cp >> 6) & 63),
        0x80 | (cp & 63)
      );
    }
  }
  return out;
}

const BASE64_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64Bytes(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += BASE64_CHARS[a >> 2];
    out += BASE64_CHARS[((a & 3) << 4) | ((b || 0) >> 4)];
    out += b === undefined ? "=" : BASE64_CHARS[((b & 15) << 2) | ((c || 0) >> 6)];
    out += c === undefined ? "=" : BASE64_CHARS[c & 63];
  }
  return out;
}

function aesCbcBase64(text, key) {
  const data = utf8Bytes(text);
  const pad = 16 - (data.length % 16);
  for (let i = 0; i < pad; i += 1) data.push(pad);
  const w = aesExpandKey(utf8Bytes(key));
  let prev = utf8Bytes(WEAPI_IV);
  const out = [];
  for (let i = 0; i < data.length; i += 16) {
    const block = new Uint8Array(16);
    for (let j = 0; j < 16; j += 1) block[j] = data[i + j] ^ prev[j];
    const enc = aesEncryptBlock(block, w);
    for (let j = 0; j < 16; j += 1) out.push(enc[j]);
    prev = Array.from(enc);
  }
  return base64Bytes(out);
}

function weapiRandomKey() {
  let key = "";
  for (let i = 0; i < 16; i += 1) {
    key += WEAPI_BASE62[Math.floor(Math.random() * WEAPI_BASE62.length)];
  }
  return key;
}

function modPow(base, exponent, modulus) {
  let result = 1n;
  base %= modulus;
  while (exponent > 0n) {
    if (exponent & 1n) result = (result * base) % modulus;
    exponent >>= 1n;
    base = (base * base) % modulus;
  }
  return result;
}

function weapiEncSecKey(key) {
  let hex = "";
  for (const ch of key.split("").reverse().join("")) {
    hex += ch.charCodeAt(0).toString(16).padStart(2, "0");
  }
  return modPow(
    BigInt("0x" + hex),
    WEAPI_EXPONENT,
    BigInt("0x" + WEAPI_MODULUS)
  )
    .toString(16)
    .padStart(256, "0");
}

async function weapi(path, data) {
  const key = weapiRandomKey();
  const payload = { ...(data || {}) };
  if (csrf() && payload.csrf_token === undefined) payload.csrf_token = csrf();
  const first = aesCbcBase64(JSON.stringify(payload), WEAPI_PRESET);
  const params = aesCbcBase64(first, key);
  const encSecKey = weapiEncSecKey(key);
  const headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": WEB_UA,
    Referer: BASE + "/",
  };
  const cookie = cookieHeader();
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + "/weapi/" + path.replace(/^\/api\//, ""), {
    method: "POST",
    headers,
    body: new URLSearchParams({ params, encSecKey }).toString(),
  });
  absorbCookies(res);
  if (res.status >= 400) {
    throw new Error(`${path}: HTTP ${res.status}`);
  }
  const raw = await res.text();
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`${path}: NetEase answered something else`);
  }
}

// writeAPI sends an edit through the eapi, then the web API, then the plain
// one, each carrying the session. A sign-in is not retried: the listener has
// to do that.
async function writeAPI(path, data) {
  let last = null;
  // The web API is the web player's own path for edits; the desktop API can
  // answer 200 for an edit it doesn't make, so it goes second.
  try {
    const answer = await weapi(path, data);
    if (typeof answer.code === "number" && answer.code !== 200) {
      throw codeError(path, answer);
    }
    return answer;
  } catch (err) {
    if (err && err.code === "signIn") throw err;
    last = err;
  }
  try {
    return await eapiOk(path, data);
  } catch (err) {
    if (err && err.code === "signIn") throw err;
    last = err;
  }
  try {
    return await post(path, data);
  } catch (err) {
    throw err || last;
  }
}

function deviceId() {
  let id = textOf(host.storage.get("deviceId") ?? "");
  if (id.length === 52) return id;
  const chars = "0123456789ABCDEF";
  id = "";
  for (let i = 0; i < 52; i += 1) {
    id += chars[Math.floor(Math.random() * 16)];
  }
  host.storage.set("deviceId", id);
  return id;
}

// ---------------------------------------------------------------------------
// The account.

async function fetchAccountStrict() {
  const data = await request("/api/nuser/account/get", { check: false });
  if (typeof data.code === "number" && data.code !== 200) {
    throw codeError("/api/nuser/account/get", data);
  }
  const profile = data.profile;
  if (!profile || !profile.userId) {
    throw fail("signIn", t("NetEase didn't confirm the sign-in. Try again."));
  }
  const account = {
    id: textOf(profile.userId),
    name: textOf(profile.nickname ?? ""),
    imageUrl: sized(profile.avatarUrl),
    page: "profile",
  };
  uid = account.id;
  accountCache = account;
  host.storage.set("uid", uid);
  host.storage.set("account", account);
  return account;
}

async function account() {
  importCookieSetting();
  if (!hasSession()) return null;
  try {
    return await fetchAccountStrict();
  } catch (err) {
    if (err && err.code === "signIn") return null;
    if (accountCache) return accountCache;
    throw err;
  }
}

async function requireUid() {
  if (uid) return uid;
  const acc = await account();
  if (!acc) {
    throw fail("signIn", t("Sign in to NetEase Cloud Music to continue."));
  }
  return String(acc.id);
}

async function qrSignIn() {
  const key = await eapi("/api/login/qrcode/unikey", { type: 3 });
  if (Number(key.code) !== 200 || !key.unikey) {
    throw fail(
      "signIn",
      textOf(key.message || key.msg) || t("NetEase refused the request. Try again later.")
    );
  }
  const url = BASE + "/login?codekey=" + key.unikey;
  host.signInPrompt({
    qr: url,
    text: t("Scan the QR code with the NetEase Cloud Music app."),
  });
  const deadline = Date.now() + 4.5 * 60 * 1000;
  let scanned = false;
  while (Date.now() < deadline) {
    await sleep(2000);
    let answer;
    try {
      answer = await eapi("/api/login/qrcode/client/login", {
        key: key.unikey,
        type: 3,
      });
    } catch (err) {
      console.log(`netease: QR check: ${err?.message || err}`);
      continue;
    }
    const code = Number(answer.code);
    if (code === 803) {
      return await fetchAccountStrict();
    }
    if (code === 802) {
      if (!scanned) {
        scanned = true;
        host.signInPrompt({
          qr: url,
          text: t("Scanned. Confirm on your phone."),
        });
      }
      continue;
    }
    if (code === 800) {
      throw fail("signIn", t("The QR code expired. Try again."));
    }
    if (code !== 801) {
      throw fail(
        "signIn",
        textOf(answer.message || answer.msg) ||
          t("NetEase didn't confirm the sign-in. Try again.")
      );
    }
  }
  throw fail("signIn", t("Signing in took too long. Try again."));
}

async function pageSignIn() {
  const answer = await host.webSignIn({
    url: BASE + "/#/login",
    cookiesOf: BASE,
    until: ["MUSIC_U"],
    userAgent: WEB_UA,
  });
  parseCookieString(answer?.cookie || "");
  return await fetchAccountStrict();
}

export async function signIn() {
  // Signing in explicitly is a fresh start: let the cookie field try again,
  // even if a previous sign-out ignored it.
  ignoreCookieSetting = false;
  host.storage.remove("ignoreCookieSetting");
  importCookieSetting();
  if ((host.setting("cookie") || "").trim()) {
    try {
      return await fetchAccountStrict();
    } catch (err) {
      if (!err || err.code !== "signIn") throw err;
      clearAuth();
    }
  }
  const method = host.setting("loginMethod") || "qr";
  if (method === "page") return await pageSignIn();
  try {
    return await qrSignIn();
  } catch (err) {
    if (err && err.code === "signIn") throw err;
    console.log(`netease: QR sign-in: ${err?.message || err}`);
    return await pageSignIn();
  }
}

export async function signOut() {
  try {
    await request("/api/logout", { method: "POST", form: {}, check: false });
  } catch (err) {
    console.log(`netease: logout: ${err?.message || err}`);
  }
  clearAuth();
  ignoreCookieSetting = true;
  host.storage.set("ignoreCookieSetting", true);
}

export { account };

export function setSetting({ key, value }) {
  if (key === "cookie" && value && value.trim()) {
    ignoreCookieSetting = false;
    host.storage.remove("ignoreCookieSetting");
    clearAuth();
    parseCookieString(value);
  }
}

// ---------------------------------------------------------------------------
// Songs and their details.

function withPrivileges(raws, privileges) {
  const byId = new Map();
  for (const p of privileges || []) {
    if (p && p.id !== undefined) byId.set(textOf(p.id), p);
  }
  for (const raw of raws || []) {
    if (!raw) continue;
    const p = byId.get(textOf(raw.id));
    if (p) raw.privilege = p;
  }
  return raws || [];
}

async function songDetails(ids) {
  const wanted = (ids || []).map(textOf).filter((id) => /^\d+$/.test(id));
  const out = [];
  for (let from = 0; from < wanted.length; from += 400) {
    const batch = wanted.slice(from, from + 400);
    const c = JSON.stringify(batch.map((id) => ({ id: Number(id) })));
    let data;
    try {
      data = await eapi("/api/v3/song/detail", { c });
      if (typeof data.code === "number" && data.code !== 200) {
        throw codeError("/api/v3/song/detail", data);
      }
    } catch (err) {
      if (err && err.code === "signIn") throw err;
      try {
        data = await weapi("/api/v3/song/detail", { c });
        if (typeof data.code === "number" && data.code !== 200) {
          throw codeError("/api/v3/song/detail", data);
        }
      } catch (fallback) {
        data = await get("/api/v3/song/detail", { c });
      }
    }
    const raws = withPrivileges(data.songs || [], data.privileges || []);
    for (const raw of raws) {
      if (!raw || raw.id === undefined) continue;
      out.push(trackOf(raw));
    }
  }
  return out;
}

async function playlistDetail(id) {
  const data = await get("/api/v6/playlist/detail", {
    id: textOf(id),
    n: 1000,
    s: 0,
  });
  const raw = data.playlist;
  if (!raw || raw.id === undefined) {
    throw fail("unavailable", t("No such page."));
  }
  const raws = withPrivileges(raw.tracks || [], data.privileges || []).filter(
    Boolean
  );
  const tracks = raws.map(trackOf);
  if (
    Array.isArray(raw.trackIds) &&
    raws.length < raw.trackIds.length
  ) {
    const ids = raw.trackIds
      .slice(raws.length, Math.min(raw.trackIds.length, 1000))
      .map((entry) => textOf(entry.id));
    if (ids.length > 0) {
      tracks.push(...(await songDetails(ids)));
    }
  }
  return playlistOf(raw, tracks);
}

async function albumPage(id) {
  const data = await get(`/api/v1/album/${textOf(id)}`);
  const raw = data.album;
  if (!raw || raw.id === undefined) {
    throw fail("unavailable", t("No such page."));
  }
  const saved = await albumSaved(textOf(id));
  const album = { ...albumOf(raw), saved };
  return { album, tracks: (data.songs || []).map(trackOf) };
}

async function artistPage(id) {
  const data = await get(`/api/v1/artist/${textOf(id)}`);
  const raw = data.artist;
  if (!raw || raw.id === undefined) {
    throw fail("unavailable", t("No such page."));
  }
  const artist = {
    id: textOf(raw.id),
    name: textOf(raw.name ?? ""),
    imageUrl: sized(raw.picUrl || raw.img1v1Url),
    following: Boolean(raw.followed),
  };
  let albums = [];
  try {
    const list = await get(`/api/artist/albums/${textOf(id)}`, {
      limit: 12,
      offset: 0,
    });
    albums = (list.hotAlbums || []).map((a) => albumOf(a));
  } catch (err) {
    console.log(`netease: artist albums: ${err?.message || err}`);
  }
  return {
    artist,
    tracks: (data.hotSongs || []).map(trackOf),
    albums,
  };
}

// ---------------------------------------------------------------------------
// The listener's library.

let userPlaylistsCache = null;
let userPlaylistsAt = 0;

async function userPlaylists(force = false) {
  if (userPlaylistsCache && !force && Date.now() - userPlaylistsAt < 60_000) {
    return userPlaylistsCache;
  }
  const data = await get("/api/user/playlist", {
    uid: await requireUid(),
    limit: 1000,
    offset: 0,
  });
  userPlaylistsCache = (data.playlist || []).map((p) => playlistOf(p));
  userPlaylistsAt = Date.now();
  return userPlaylistsCache;
}

async function likedPlaylistId() {
  const all = await userPlaylists();
  return all.find((p) => p.fixed)?.id || "";
}

async function likedIds() {
  if (likedCache && Date.now() - likedAt < 60_000) return likedCache;
  const uidNow = await requireUid();
  let ids = null;
  try {
    const data = await eapiOk("/api/song/like/get", { uid: uidNow });
    if (Array.isArray(data.ids)) ids = data.ids.map(textOf);
  } catch (err) {
    if (err && err.code === "signIn") throw err;
  }
  if (!ids || ids.length === 0) {
    try {
      const data = await weapi("/api/song/like/get", { uid: uidNow });
      if (
        typeof data.code === "number" &&
        data.code === 200 &&
        Array.isArray(data.ids) &&
        data.ids.length > 0
      ) {
        ids = data.ids.map(textOf);
      }
    } catch (err) {
      if (err && err.code === "signIn") throw err;
    }
  }
  if (!ids || ids.length === 0) {
    // The like endpoint can answer 200 with no ids while the web player's
    // liked playlist still lists them; that playlist is the truthful page.
    const pid = await likedPlaylistId();
    if (pid) {
      const page = await playlistDetail(pid);
      const fromPlaylist = (page.tracks || []).map((track) => track.id);
      if (fromPlaylist.length > 0) ids = fromPlaylist;
    }
  }
  likedCache = ids || [];
  likedAt = Date.now();
  return likedCache;
}

async function albumList(offset) {
  const form = { limit: 100, offset, total: true };
  try {
    return await eapiOk("/api/album/sublist", form);
  } catch (err) {
    if (err && err.code === "signIn") throw err;
  }
  try {
    const answer = await weapi("/api/album/sublist", form);
    if (typeof answer.code === "number" && answer.code !== 200) {
      throw codeError("/api/album/sublist", answer);
    }
    return answer;
  } catch (err) {
    if (err && err.code === "signIn") throw err;
    return await post("/api/album/sublist", form);
  }
}

// The saved albums list names its page `albums` on the desktop API and `data`
// on the web API.
function albumArray(answer) {
  const list = answer?.albums ?? answer?.data;
  return Array.isArray(list) ? list : [];
}

let albumSweep = null;

async function albumSavedSet(force = false) {
  if (savedAlbumCache && !force && Date.now() - savedAlbumAt < 60_000) {
    return savedAlbumCache;
  }
  if (!hasSession()) return new Set();
  if (!albumSweep) {
    albumSweep = (async () => {
      const ids = new Set();
      try {
        for (let offset = 0; offset < 2000; offset += 100) {
          const data = await albumList(offset);
          const albums = albumArray(data);
          for (const album of albums) ids.add(textOf(album.id));
          if (!data.hasMore && albums.length < 100) break;
        }
      } catch (err) {
        console.log(`netease: saved albums: ${err?.message || err}`);
      }
      savedAlbumCache = ids;
      savedAlbumAt = Date.now();
      albumSweep = null;
      return ids;
    })();
  }
  return await albumSweep;
}

async function albumSaved(id) {
  const set = await albumSavedSet();
  return set.has(textOf(id));
}

export async function playlists() {
  if (!hasSession()) return [];
  try {
    return await userPlaylists(true);
  } catch (err) {
    if (err && err.code === "signIn") return [];
    throw err;
  }
}

export async function playlist({ id }) {
  return await playlistDetail(id);
}

export async function album({ id }) {
  return await albumPage(id);
}

export async function artist({ id }) {
  return await artistPage(id);
}

export async function liked({ offset }) {
  const ids = await likedIds();
  const from = Math.max(0, Number(offset) || 0);
  const page = ids.slice(from, from + LIKED_PAGE);
  return {
    tracks: await songDetails(page),
    more: from + page.length < ids.length,
  };
}

export async function isLiked({ ids }) {
  const list = (ids || []).map(textOf);
  const result = {};
  const episodes = [];
  const songs = [];
  for (const id of list) {
    if (programByTrack.has(id)) episodes.push(id);
    else songs.push(id);
  }
  if (songs.length > 0) {
    try {
      const set = new Set(await likedIds());
      for (const id of songs) result[id] = set.has(id);
    } catch (err) {
      if (!err || err.code !== "signIn") throw err;
      for (const id of songs) result[id] = false;
    }
  }
  if (episodes.length > 0) {
    if (!hasSession()) {
      for (const id of episodes) result[id] = false;
    } else {
      try {
        const answer = await writeAPI("/api/resource/commentInfo/list", {
          resourceType: "1",
          resourceIds: `[${episodes
            .map((id) => programByTrack.get(id))
            .join(",")}]`,
        });
        const liked = new Map(
          (answer.data || []).map((entry) => [
            textOf(entry.resourceId),
            Boolean(entry.liked),
          ])
        );
        for (const id of episodes) {
          result[id] = liked.get(programByTrack.get(id)) || false;
        }
      } catch (err) {
        if (err && err.code === "signIn") {
          for (const id of episodes) result[id] = false;
        } else {
          for (const id of episodes) result[id] = false;
        }
      }
    }
  }
  return result;
}

export async function likeEpisode({ id, on }) {
  const program = programByTrack.get(textOf(id));
  if (!program) {
    throw fail("unsupported", t("This episode's program isn't known yet."));
  }
  const path = on ? "/api/resource/like" : "/api/resource/unlike";
  await writeAPI(path, { threadId: "A_DJ_1_" + program });
}

export async function like({ id, on }) {
  const trackId = textOf(id);
  const form = {
    alg: "itembased",
    trackId,
    like: on ? "true" : "false",
    time: "3",
  };
  await writeAPI("/api/radio/like", form);
  if (likedCache) {
    if (on && !likedCache.includes(trackId)) likedCache.unshift(trackId);
    if (!on) likedCache = likedCache.filter((x) => x !== trackId);
    likedAt = Date.now();
  }
}

export async function recent() {
  if (!hasSession()) return [];
  try {
    let data;
    try {
      data = await eapiOk("/api/play-record/song/list", { limit: 50 });
    } catch (err) {
      if (err && err.code === "signIn") return [];
      try {
        data = await weapi("/api/play-record/song/list", { limit: 50 });
      } catch (fallback) {
        data = await post("/api/play-record/song/list", { limit: 50 });
      }
    }
    return ((data.data?.list || [])
      .map((entry) => trackOf(entry.data))
      .filter((track) => track && track.id));
  } catch (err) {
    if (err && err.code === "signIn") return [];
    console.log(`netease: recent: ${err?.message || err}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Editing playlists and collections.

function trackIdsJson(ids) {
  return JSON.stringify(
    (ids || []).map(Number).filter((id) => Number.isFinite(id))
  );
}

export async function createPlaylist({ name }) {
  const data = await writeAPI("/api/playlist/create", {
    name,
    privacy: "0",
    type: "NORMAL",
  });
  const raw = data.playlist || {
    id: data.id,
    name,
    creator: { userId: uid },
    trackCount: 0,
  };
  userPlaylistsCache = null;
  return playlistOf(raw, []);
}

export async function renamePlaylist({ id, name }) {
  await writeAPI("/api/playlist/update/name", { id: textOf(id), name });
  userPlaylistsCache = null;
}

export async function deletePlaylist({ id }) {
  await writeAPI("/api/playlist/remove", { ids: `[${textOf(id)}]` });
  userPlaylistsCache = null;
}

async function manipulatePlaylist(op, id, trackIds) {
  const form = {
    op,
    pid: textOf(id),
    trackIds: trackIdsJson(trackIds),
    imme: "true",
  };
  const send = async (body) => await writeAPI("/api/playlist/manipulate/tracks", body);
  let answer = await send(form);
  if (Number(answer.code) === 512) {
    const doubled = (trackIds || []).concat(trackIds || []);
    answer = await send({ ...form, trackIds: trackIdsJson(doubled) });
  }
  if (Number(answer.code) === 502) {
    throw fail("unavailable", t("The song is in the playlist already."));
  }
  if (typeof answer.code === "number" && answer.code !== 200) {
    throw codeError("/api/playlist/manipulate/tracks", answer);
  }
  userPlaylistsCache = null;
}

export async function addToPlaylist({ id, trackIds }) {
  await manipulatePlaylist("add", id, trackIds);
}

export async function removeFromPlaylist({ id, trackIds }) {
  await manipulatePlaylist("del", id, trackIds);
}

export async function savePlaylist({ id, on }) {
  const path = on ? "/api/playlist/subscribe" : "/api/playlist/unsubscribe";
  await writeAPI(path, { id: textOf(id) });
  userPlaylistsCache = null;
}

export async function saveAlbum({ id, on }) {
  const path = on ? "/api/album/sub" : "/api/album/unsub";
  await writeAPI(path, { id: textOf(id) });
  savedAlbumCache = null;
  savedAlbumAt = 0;
}

export async function followArtist({ id, on }) {
  const path = on ? "/api/artist/sub" : "/api/artist/unsub";
  const form = {
    artistId: textOf(id),
    artistIds: `[${textOf(id)}]`,
  };
  await writeAPI(path, form);
}

export async function savedAlbums({ offset }) {
  const from = Math.max(0, Number(offset) || 0);
  let data;
  try {
    data = await albumList(from);
  } catch (err) {
    if (err && err.code === "signIn") throw err;
    throw err;
  }
  const albums = albumArray(data).map((a) => ({
    ...albumOf(a),
    saved: true,
  }));
  if (savedAlbumCache) {
    for (const album of albums) savedAlbumCache.add(album.id);
  }
  return {
    albums,
    more:
      Boolean(data.hasMore) ||
      albumArray(data).length >= 100,
  };
}

// ---------------------------------------------------------------------------
// Search and suggestions.

export async function search({ query, kind, offset }) {
  const type =
    { tracks: 1, albums: 10, artists: 100, playlists: 1000, shows: 1009 }[
      kind
    ] || 1;
  const from = Math.max(0, Number(offset) || 0);
  const data = await get("/api/cloudsearch/pc", {
    s: query,
    type,
    limit: PAGE_SIZE,
    offset: from,
    total: true,
  });
  const result = data.result || {};
  const countKey = {
    tracks: "songCount",
    albums: "albumCount",
    artists: "artistCount",
    playlists: "playlistCount",
    shows: "djRadiosCount",
  }[kind];
  const total = Number(result[countKey] || 0);
  let page = [];
  if (kind === "tracks") {
    page = (result.songs || []).map(trackOf);
  } else if (kind === "albums") {
    page = (result.albums || []).map((a) => albumOf(a));
  } else if (kind === "artists") {
    page = (result.artists || []).map((raw) => ({
      id: textOf(raw.id ?? ""),
      name: textOf(raw.name ?? ""),
      imageUrl: sized(raw.img1v1Url || raw.picUrl),
    }));
  } else if (kind === "playlists") {
    page = (result.playlists || []).map((p) => playlistOf(p));
  } else if (kind === "shows") {
    page = (result.djRadios || []).map(showOf);
  }
  return {
    [kind]: page,
    more: total > 0 ? from + page.length < total : page.length >= PAGE_SIZE,
  };
}

export async function suggest({ query }) {
  const data = await get("/api/search/suggest/web", { s: query });
  const result = data.result || {};
  const order = result.order || ["songs", "artists", "albums", "playlists"];
  const out = [];
  for (const key of order) {
    for (const item of result[key] || []) {
      const name = textOf(item.name);
      if (name) out.push(name);
    }
  }
  return [...new Set(out)].slice(0, 10);
}

// ---------------------------------------------------------------------------
// Podcasts and stations.

export async function shows() {
  if (!hasSession()) return [];
  const query = { limit: 100, offset: 0, total: true };
  try {
    const data = await get("/api/djradio/get/subed", query);
    return (data.djRadios || []).map(showOf);
  } catch (err) {
    if (err && err.code === "signIn") return [];
    try {
      const data = await weapi("/api/djradio/get/subed", query);
      if (typeof data.code === "number" && data.code !== 200) {
        throw codeError("/api/djradio/get/subed", data);
      }
      return (data.djRadios || []).map(showOf);
    } catch (fallback) {
      if (fallback && fallback.code === "signIn") return [];
      throw fallback;
    }
  }
}

export async function show({ id, offset }) {
  const from = Math.max(0, Number(offset) || 0);
  const data = await get("/api/djradio/v2/get", { id: textOf(id) });
  const raw = data.data;
  if (!raw || raw.id === undefined) {
    throw fail("unavailable", t("No such page."));
  }
  const episodesData = await get("/api/dj/program/byradio", {
    radioId: textOf(id),
    limit: PAGE_SIZE,
    offset: from,
    asc: false,
  });
  const episodes = (episodesData.programs || [])
    .map((program) => episodeOf(program, raw))
    .filter(Boolean);
  return {
    show: showOf(raw),
    episodes,
    more: Boolean(episodesData.more) || episodes.length >= PAGE_SIZE,
  };
}

export async function subscribeShow({ id, on }) {
  const path = on ? "/api/djradio/sub" : "/api/djradio/unsub";
  await writeAPI(path, { id: textOf(id) });
}

export function stations() {
  return [
    {
      id: "DEFAULT",
      name: t("Personal FM"),
      description: t("Songs picked for your taste"),
      imageUrl: sized(accountCache?.imageUrl),
    },
    {
      id: "FAMILIAR",
      name: t("Familiar"),
      description: t("Songs like the ones you know"),
      imageUrl: sized(accountCache?.imageUrl),
    },
    {
      id: "EXPLORE",
      name: t("Explore"),
      description: t("Songs new to you"),
      imageUrl: sized(accountCache?.imageUrl),
    },
  ];
}

export async function stationNext({ id }) {
  const mode = ["DEFAULT", "FAMILIAR", "EXPLORE"].includes(id)
    ? id
    : "DEFAULT";
  try {
    let data;
    try {
      data = await eapiOk("/api/v1/radio/get", { mode, limit: 3 });
    } catch (err) {
      if (err && err.code === "signIn") throw err;
      try {
        data = await weapi("/api/v1/radio/get", { mode, limit: 3 });
        if (typeof data.code === "number" && data.code !== 200) {
          throw codeError("/api/v1/radio/get", data);
        }
      } catch (fallback) {
        data = await post("/api/v1/radio/get", { mode, limit: 3 });
      }
    }
    const ids = (data.data || [])
      .map((entry) => textOf(entry.id))
      .filter((songId) => songId);
    return await songDetails(ids);
  } catch (err) {
    if (err && err.code === "signIn") throw err;
    throw fail(
      "unavailable",
      t("NetEase refused the request. Try again later.")
    );
  }
}

// ---------------------------------------------------------------------------
// Comments.

function threadOf(id) {
  const track = textOf(id);
  const program = programByTrack.get(track);
  return program ? "A_DJ_1_" + program : "R_SO_4_" + track;
}

export async function comments({ trackId, offset }) {
  const from = Math.max(0, Number(offset) || 0);
  const data = await get(
    "/api/v1/resource/comments/" + threadOf(trackId),
    { limit: PAGE_SIZE, offset: from }
  );
  const comments = (data.comments || []).map(commentOf);
  return {
    comments,
    total: Number(data.total || comments.length),
    more:
      Boolean(data.more) ||
      from + comments.length < Number(data.total || 0),
  };
}

export async function likeComment({ trackId, commentId, on }) {
  const path = on ? "/api/v1/comment/like" : "/api/v1/comment/unlike";
  await writeAPI(path, {
    threadId: threadOf(trackId),
    commentId: textOf(commentId),
  });
}

export async function postComment({ trackId, text }) {
  const threadId = threadOf(trackId);
  const data = await writeAPI("/api/resource/comments/add", {
    threadId,
    content: text,
    csrf_token: csrf(),
  });
  const raw = data.comment || {};
  return {
    id: textOf(raw.commentId ?? ""),
    author: textOf(raw.user?.nickname ?? accountCache?.name ?? ""),
    avatarUrl: sized(raw.user?.avatarUrl ?? accountCache?.imageUrl),
    text: textOf(raw.content ?? text),
    time: Number(raw.time ?? Date.now()),
    likes: 0,
  };
}

// ---------------------------------------------------------------------------
// Lyrics.

function parseLRC(lrc) {
  const time = /\[(\d+):(\d+)(?:[.:](\d+))?\]/g;
  const out = [];
  for (const raw of String(lrc || "").split("\n")) {
    const times = [...raw.matchAll(time)];
    if (times.length === 0) continue;
    const last = times[times.length - 1];
    const text = raw.slice(last.index + last[0].length).trim();
    for (const m of times) {
      let ms = Number(m[1]) * 60_000 + Number(m[2]) * 1000;
      if (m[3]) {
        ms += Number(m[3]) * Math.pow(10, 3 - m[3].length);
      }
      out.push({ start: ms, text });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

function parseYRC(yrc) {
  const line = /^\[(\d+),(\d+)\]/;
  const word = /\((\d+),(\d+),\d+\)([^(]*)/g;
  const out = [];
  for (const raw of String(yrc || "").split("\n")) {
    const m = raw.match(line);
    if (!m) continue;
    const start = Number(m[1]);
    const end = start + Number(m[2]);
    const words = [];
    for (const w of raw.slice(m[0].length).matchAll(word)) {
      const wordStart = Number(w[1]);
      const wordEnd = wordStart + Number(w[2]);
      const text = w[3];
      if (!text.trim()) {
        if (words.length > 0) words[words.length - 1].text += " ";
        continue;
      }
      words.push({ start: wordStart, end: wordEnd, text });
    }
    const text = words.map((w) => w.text).join("").trim();
    if (text) out.push({ start, end, text, words });
  }
  return out.sort((a, b) => a.start - b.start);
}

export async function lyrics({ id }) {
  const data = await get("/api/song/lyric", {
    id: textOf(id),
    lv: 1,
    tv: -1,
  });
  const lrc = textOf(data.lrc?.lyric);
  const translation = textOf(data.tlyric?.lyric);
  let lines = [];
  const wordForm = {
    id: textOf(id),
    cp: false,
    tv: 0,
    lv: 0,
    rv: 0,
    kv: 0,
    yv: 0,
    ytv: 0,
    yrv: 0,
  };
  try {
    let words;
    try {
      words = await eapi("/api/song/lyric/v1", wordForm);
    } catch (err) {
      words = await weapi("/api/song/lyric/v1", wordForm);
    }
    if (words && typeof words.code === "number" && words.code === 200) {
      lines = parseYRC(words.yrc?.lyric);
    }
  } catch (err) {
    console.log(`netease: word lyrics: ${err?.message || err}`);
  }
  if (lines.length > 0) {
    const translated = parseLRC(translation);
    for (const line of translated) {
      if (!line.text) continue;
      let best = null;
      let gap = 1500;
      for (const want of lines) {
        const d = Math.abs(want.start - line.start);
        if (d < gap) {
          best = want;
          gap = d;
        }
      }
      if (best && !best.translation) best.translation = line.text;
    }
  }
  return { lrc, translation, lines };
}

// ---------------------------------------------------------------------------
// Audio.

function levelFor(quality) {
  const asked =
    quality === "lossless"
      ? "hires"
      : quality === "high"
        ? "exhigh"
        : "standard";
  const cap = host.setting("maxQuality") || "hires";
  const a = NET_LEVELS.indexOf(asked);
  const b = NET_LEVELS.indexOf(cap);
  if (a < 0) return "standard";
  if (b < 0) return asked;
  return NET_LEVELS[Math.min(a, b)];
}

function levelsFrom(level) {
  const at = Math.max(0, NET_LEVELS.indexOf(level));
  return NET_LEVELS.slice(0, at + 1).reverse();
}

function playableURL(item) {
  return Boolean(
    item &&
      item.url &&
      (!item.freeTrialInfo || String(item.freeTrialInfo) === "null")
  );
}

async function streamAt(id, level) {
  const encode = level === "lossless" || level === "hires" ? "flac" : "mp3";
  const form = {
    ids: `[${textOf(id)}]`,
    level,
    encodeType: encode,
  };
  let item = null;
  try {
    const data = await eapi("/api/song/enhance/player/url/v1", form);
    if (typeof data.code === "number" && data.code !== 200) {
      throw codeError("/api/song/enhance/player/url/v1", data);
    }
    item = data?.data?.[0] || null;
  } catch (err) {
    if (err && err.code === "signIn") throw err;
    console.log(`netease: eapi stream: ${err?.message || err}`);
  }
  if (!playableURL(item)) {
    // The web API is the web player's own way, and carries the session.
    try {
      const data = await weapi("/api/song/enhance/player/url/v1", form);
      if (typeof data.code === "number" && data.code !== 200) {
        throw codeError("/api/song/enhance/player/url/v1", data);
      }
      item = data?.data?.[0] || null;
    } catch (err) {
      if (err && err.code === "signIn") throw err;
      console.log(`netease: weapi stream: ${err?.message || err}`);
    }
  }
  if (!playableURL(item)) {
    // The plain API serves free songs and is the last way in.
    try {
      const data = await post("/api/song/enhance/player/url/v1", form);
      item = data?.data?.[0] || null;
    } catch (err) {
      console.log(`netease: web player URL: ${err?.message || err}`);
    }
  }
  if (!playableURL(item)) return null;
  let type = textOf(item.type).toLowerCase();
  if (type !== "mp3" && type !== "flac") {
    if (/\.flac(\?|$)/i.test(item.url)) type = "flac";
    else type = "mp3";
  }
  return {
    url: textOf(item.url).replace(/^http:\/\//, "https://"),
    type,
    quality: textOf(item.level) || level,
    bitRate: Number(item.br || 0),
    size: Number(item.size || 0),
    gain: Number(item.gain || 0),
    peak: Number(item.peak || 0),
    headers: {
      Referer: BASE + "/",
      "User-Agent": WEB_UA,
    },
  };
}

export async function stream({ id, quality }) {
  const wanted = levelFor(quality);
  let last = null;
  for (const level of levelsFrom(wanted)) {
    try {
      const answer = await streamAt(id, level);
      if (answer) return answer;
    } catch (err) {
      if (err && err.code === "signIn") throw err;
      last = err;
      console.log(`netease: stream ${level}: ${err?.message || err}`);
    }
  }
  throw fail(
    "unavailable",
    textOf(last?.message) || t("This song isn't available to stream.")
  );
}

// ---------------------------------------------------------------------------
// Home and the pages it links to.

async function dailySongs() {
  try {
    const data = await get("/api/v3/discovery/recommend/songs");
    return (data.data?.dailySongs || []).map(trackOf);
  } catch (err) {
    console.log(`netease: daily songs: ${err?.message || err}`);
    return [];
  }
}

async function recommendedPlaylists() {
  if (hasSession()) {
    try {
      const data = await get("/api/v1/discovery/recommend/resource");
      const list = data.recommend || [];
      if (list.length > 0) return list.map((p) => playlistOf(p));
    } catch (err) {
      console.log(`netease: recommended for you: ${err?.message || err}`);
    }
  }
  try {
    const data = await get("/api/personalized/playlist", { limit: 12 });
    return (data.result || []).map((p) => playlistOf(p));
  } catch (err) {
    console.log(`netease: featured playlists: ${err?.message || err}`);
    return [];
  }
}

async function charts() {
  try {
    const data = await get("/api/toplist/detail");
    const list = (data.list || []).map((p) => playlistOf(p));
    // Some charts come without their cover, as the Honor one does: the chart's
    // own page has it, so ask there for the cover it shows.
    await Promise.all(
      list
        .filter((p) => p.imageUrl === "" && p.id !== "")
        .map(async (p) => {
          try {
            p.imageUrl = await playlistCover(p.id);
          } catch (err) {
            console.log(`netease: chart cover ${p.id}: ${err?.message || err}`);
          }
        })
    );
    return list;
  } catch (err) {
    console.log(`netease: charts: ${err?.message || err}`);
    return [];
  }
}

// playlistCover asks for the cover a playlist's page shows, for a playlist the
// list it came in left without one.
async function playlistCover(id) {
  const data = await get("/api/v6/playlist/detail", { id: textOf(id), n: 1, s: 0 });
  const raw = data.playlist;
  if (!raw) return "";
  return sized(raw.coverImgUrl || raw.picUrl || raw.coverImageUrl);
}

async function newSongs() {
  try {
    const data = await get("/api/personalized/newsong", { limit: 12 });
    return (data.result || [])
      .map((entry) => entry.song || entry)
      .map(trackOf);
  } catch (err) {
    console.log(`netease: new songs: ${err?.message || err}`);
    return [];
  }
}

async function recommendedPodcasts() {
  try {
    const data = await get("/api/djradio/recommend/v1");
    return (data.djRadios || []).map(showOf);
  } catch (err) {
    console.log(`netease: recommended podcasts: ${err?.message || err}`);
    return [];
  }
}

export async function home() {
  const results = await Promise.allSettled([
    dailySongs(),
    recommendedPlaylists(),
    charts(),
    newSongs(),
  ]);
  const [daily, playlists, chartList, fresh] = results.map((r) =>
    r.status === "fulfilled" ? r.value : []
  );
  const sections = [];
  if (daily.length > 0) {
    sections.push({
      title: t("Daily Recommendations"),
      tracks: daily,
      pageTitle: t("Daily Recommendations"),
      subtitle: t("Picked for your taste, new every day at 6:00"),
      morePage: "daily",
    });
  }
  if (playlists.length > 0) {
    sections.push({
      title: t("Recommended Playlists"),
      playlists: playlists.slice(0, 12),
      morePage: "playlists",
    });
  }
  if (chartList.length > 0) {
    sections.push({
      title: t("Charts"),
      playlists: chartList.slice(0, 12),
      morePage: "charts",
    });
  }
  if (fresh.length > 0) {
    sections.push({
      title: t("New Songs"),
      tracks: fresh,
      morePage: "new",
    });
  }
  if (sections.length === 0) {
    throw fail(
      "unavailable",
      t("NetEase refused the request. Try again later.")
    );
  }
  return { title: t("NetEase Cloud Music"), sections };
}

export async function browse({ page }) {
  switch (page) {
    case "daily": {
      const tracks = await dailySongs();
      return {
        title: t("Daily Recommendations"),
        subtitle: t("Picked for your taste, new every day at 6:00"),
        sections: [
          {
            title: t("Daily Recommendations"),
            tracks,
            pageTitle: t("Daily Recommendations"),
            subtitle: t("Picked for your taste, new every day at 6:00"),
          },
        ],
      };
    }
    case "charts":
      return {
        title: t("Charts"),
        subtitle: t("NetEase's charts"),
        sections: [{ title: t("Charts"), playlists: await charts() }],
      };
    case "playlists":
      return {
        title: t("Recommended Playlists"),
        subtitle: t("The playlists NetEase recommends"),
        sections: [
          {
            title: t("Recommended Playlists"),
            playlists: await recommendedPlaylists(),
          },
        ],
      };
    case "new":
      return {
        title: t("New Songs"),
        subtitle: t("New songs NetEase recommends"),
        sections: [{ title: t("New Songs"), tracks: await newSongs() }],
      };
    case "recent": {
      const tracks = await recent();
      if (!hasSession()) {
        throw fail("signIn", t("Sign in to see what you played."));
      }
      return {
        title: t("Recently Played"),
        subtitle: t("What you played last"),
        sections: [{ title: t("Recently Played"), tracks }],
      };
    }
    case "podcasts":
      return {
        title: t("My Podcasts"),
        subtitle: t("Podcasts NetEase recommends"),
        sections: [
          {
            title: t("My Podcasts"),
            shows: await recommendedPodcasts(),
          },
        ],
      };
    case "profile": {
      const acc = await account();
      if (!acc) {
        throw fail("signIn", t("Sign in to see your playlists."));
      }
      const all = await userPlaylists(true);
      return {
        title: acc.name,
        imageUrl: acc.imageUrl,
        description: t("Your NetEase profile"),
        sections: [
          {
            title: t("My Playlists"),
            playlists: all.filter((p) => p.mine),
          },
          {
            title: t("Saved Playlists"),
            playlists: all.filter((p) => !p.mine),
          },
        ],
      };
    }
    default:
      throw fail("unavailable", t("No such page."));
  }
}
