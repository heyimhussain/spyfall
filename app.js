// Spyfall — P2P multiplayer via PeerJS (no backend setup needed)
const PEER_PREFIX = "spyfall-v1-";
const $ = (id) => document.getElementById(id);
const screens = ["home", "join", "create", "watch", "setup", "manage", "custom", "lobby", "game", "present"];

// minimal line icons (no emoji)
const SVG_EYE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`;
const SVG_EYE_OFF = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.6 10.6 0 0 1 12 19C6.5 19 2.7 13.5 2 12a17.6 17.6 0 0 1 4.06-4.94M9.9 5.2A10.4 10.4 0 0 1 12 5c5.5 0 9.3 5.5 10 7a17.7 17.7 0 0 1-2.16 3.19M14.12 14.12A3 3 0 1 1 9.88 9.88"/><path d="M2 2l20 20"/></svg>`;
const SVG_SWAP = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`;
const SVG_CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 12.5l2.7 2.7L16 9.5"/></svg>`;

let myName = "";
let myId = "p_" + Math.random().toString(36).slice(2, 10);
let isHost = false;
let peer = null;
let conns = {}; // host: peerId -> DataConnection (players)
let viewers = {}; // host: peerId -> DataConnection (projector screens)
let viewing = false; // this device joined as projector screen
let wasKicked = false;
let joinAnswered = false; // host replied (state/error) to our hello
let joinFailed = false; // host rejected the join
let hostConn = null; // client: connection to host
let lobby = null; // shared state from host
let myPeerId = null;
let revealed = false;
let suspect = null;
let spyGuess = null;
const expandedDecks = new Set();

let currentScreen = "home";
function show(name) {
  const changed = currentScreen !== name;
  currentScreen = name;
  screens.forEach((s) => $("screen-" + s).classList.toggle("active", s === name));
  document.querySelector(".app").classList.toggle("wide", name === "present");
  const boot = $("qr-boot");
  if (boot) boot.style.display = "none";
  if (changed) window.scrollTo({ top: 0 });
}
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), 2200);
}
let confirmCb = null;
function askConfirm(title, body, yesLabel, cb) {
  $("confirm-title").textContent = title;
  $("confirm-body").textContent = body;
  $("confirm-yes").textContent = yesLabel || "Delete";
  confirmCb = cb;
  $("confirm").classList.add("show");
}
$("confirm-no").onclick = () => { $("confirm").classList.remove("show"); confirmCb = null; };
$("confirm").onclick = (e) => { if (e.target.id === "confirm") { $("confirm").classList.remove("show"); confirmCb = null; } };
$("confirm-yes").onclick = () => { $("confirm").classList.remove("show"); if (confirmCb) confirmCb(); confirmCb = null; };
function genCode(len = 5) {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no confusing chars
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function gameLink(code) {
  // QR points back to this page with ?code=
  const base = location.href.split("?")[0];
  if (base.startsWith("file:")) return code; // file:// can't be scanned usefully
  return base + "?code=" + code;
}
function allDeckIds() { return allDecks().map((d) => d.id); }
function defaultDeckIds() { return ["classic"]; }

// ---------- CUSTOM DECKS (localStorage) ----------
const CUSTOM_KEY = "spyfall-custom-decks-v1";
function getCustomDecks() {
  try { return JSON.parse(localStorage.getItem(CUSTOM_KEY)) || []; }
  catch { return []; }
}
function saveCustomDecks(decks) {
  try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(decks)); } catch {}
}
function allDecks(extra) {
  const seen = new Set();
  const out = [];
  [...LOCATION_DECKS, ...getCustomDecks(), ...(extra || [])].forEach((d) => {
    if (!d || !d.id || seen.has(d.id)) return;
    seen.add(d.id);
    out.push(d);
  });
  const PINNED = ["classic", "cities"];
  out.sort((a, b) => {
    const ai = PINNED.indexOf(a.id), bi = PINNED.indexOf(b.id);
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  return out;
}
function allLocations(deckIds, extra) {
  return allDecks(extra)
    .filter((d) => deckIds.includes(d.id))
    .flatMap((d) => (d.locations || [])
      .filter((l) => l && l.name && l.name.trim() && (l.roles || []).some((r) => r && r.trim()))
      .map((l) => ({ name: l.name.trim(), roles: l.roles.map((r) => r.trim()).filter(Boolean), deck: d.name })));
}

// ---------- REMEMBERED SETTINGS (localStorage) ----------
const SETTINGS_KEY = "spyfall-settings-v1";
function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; }
  catch { return {}; }
}
function saveSettings(patch) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...loadSettings(), ...patch })); } catch {}
}

// ---------- LOCATION BLOCK: location main, roles expandable under it ----------
const expandedLocs = new Set();
function makeLocBlock(ns, name, roles, opts = {}) {
  const key = ns + "::" + name;
  const open = expandedLocs.has(key);
  const box = document.createElement("div");
  box.className = "loc-block" + (open ? " open" : "") + (opts.mine ? " mine" : "") + (opts.selected ? " guess-sel" : "");
  const h = document.createElement("div");
  h.className = "loc-block-head";
  const label = document.createElement("span");
  label.className = "loc-block-name";
  label.textContent = (opts.marker || "") + name;
  const toggle = () => {
    open ? expandedLocs.delete(key) : expandedLocs.add(key);
    opts.onToggle && opts.onToggle();
  };
  label.onclick = (e) => {
    e.stopPropagation();
    if (opts.selectable && opts.onSelect) opts.onSelect();
    else toggle();
  };
  const chev = document.createElement("span");
  chev.className = "chev sm";
  chev.textContent = "›";
  h.onclick = toggle;
  h.appendChild(label);
  h.appendChild(chev);
  box.appendChild(h);
  const r = document.createElement("div");
  r.className = "loc-roles";
  const rIn = document.createElement("div");
  rIn.className = "loc-roles-inner";
  roles.forEach((role) => {
    const s = document.createElement("span");
    s.className = "loc-role";
    s.textContent = role;
    rIn.appendChild(s);
  });
  r.appendChild(rIn);
  box.appendChild(r);
  return box;
}

// ---------- HOME ----------
$("btn-create").onclick = () => {
  $("create-name").value = loadSettings().name || "";
  show("create");
  if (!$("create-name").value) setTimeout(() => $("create-name").focus(), 150);
};
$("btn-back-create").onclick = () => show("home");
$("create-name").addEventListener("input", (e) => saveSettings({ name: e.target.value.slice(0, 20) }));
$("btn-create-confirm").onclick = () => {
  myName = $("create-name").value.trim();
  if (!myName) return toast("Enter your name first");
  saveSettings({ name: myName });
  createGame();
};
$("btn-join-go").onclick = () => {
  $("join-name").value = loadSettings().name || "";
  show("join");
  const pre = new URLSearchParams(location.search).get("code");
  if (pre) $("code-input").value = pre.toUpperCase();
};
$("btn-join-confirm").onclick = () => {
  myName = $("join-name").value.trim();
  if (!myName) return toast("Enter your name first");
  saveSettings({ name: myName });
  const code = $("code-input").value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== 5) return toast("Enter the 5-character code");
  joinGame(code, false);
};
$("btn-watch-go").onclick = () => {
  show("watch");
  const pre = new URLSearchParams(location.search).get("code");
  if (pre) $("watch-input").value = pre.toUpperCase();
};
$("btn-back-watch").onclick = () => show("home");
$("btn-watch-confirm").onclick = () => {
  const code = $("watch-input").value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== 5) return toast("Enter the 5-character code");
  joinGame(code, true);
};
$("btn-offline").onclick = () => {
  const savedName = loadSettings().name;
  setupPlayers = [savedName || "Player 1", "Player 2", "Player 3"];
  const sv = loadSettings().setup || {};
  if (Array.isArray(sv.players) && sv.players.length >= 3) setupPlayers = sv.players.slice(0, 12);
  setupSpies = sv.spies >= 1 ? sv.spies : 1;
  const validSetupDecks = (sv.decks || []).filter((id) => allDecks().some((d) => d.id === id));
  setupDecks = validSetupDecks.length ? validSetupDecks : defaultDeckIds();
  show("setup");
  renderSetup();
};
$("btn-back-home").onclick = () => show("home");
$("join-name").addEventListener("input", (e) => saveSettings({ name: e.target.value.slice(0, 20) }));
$("btn-back-setup").onclick = () => show("home");

// ---------- HOST ----------
function destroyPeer() {
  try { hostConn && hostConn.close(); } catch {}
  try { Object.values(conns).forEach((c) => c.close()); } catch {}
  try { Object.values(viewers).forEach((c) => c.close()); } catch {}
  try { peer && peer.destroy(); } catch {}
  peer = null; conns = {}; viewers = {}; hostConn = null;
}

function createGame() {
  destroyPeer();
  isHost = true;
  const code = genCode(5);
  myPeerId = PEER_PREFIX + code;
  peer = new Peer(myPeerId, { debug: 0 });
  peer.on("open", () => {
    const savedHost = loadSettings().host || {};
    const validDecks = (savedHost.decks || []).filter((id) => allDecks().some((d) => d.id === id));
    lobby = {
      code,
      status: "lobby",
      spyCount: savedHost.spyCount >= 1 ? savedHost.spyCount : 1,
      decks: validDecks.length ? validDecks : defaultDeckIds(),
      players: [{ id: myId, name: myName, host: true }],
      round: null,
      reveal: false,
    };
    enterLobby();
    peer.on("connection", onGuestConnect);
  });
  peer.on("error", (e) => {
    if (e.type === "unavailable-id") return createGame(); // collision, retry
    toast("Connection error: " + e.type);
  });
}

function onGuestConnect(c) {
  // attach immediately — a hello arriving before "open" must not be missed
  c.on("data", (msg) => onGuestMessage(c, msg));
  c.on("close", () => removePeer(c.peer));
  c.on("error", () => removePeer(c.peer));
}

function onGuestMessage(c, msg) {
  if (!msg || !msg.t) return;
  if (msg.t === "hello") {
    if (msg.player.viewer) {
      viewers[c.peer] = c; // projector screen: watch only
      try { c.send({ t: "state", lobby }); } catch {}
      return;
    }
    c._pid = msg.player.id;
    if (lobby.status !== "lobby" && !lobby.players.some((p) => p.id === msg.player.id)) {
      try { c.send({ t: "error", msg: "Game already started" }); } catch {}
      setTimeout(() => { try { c.close(); } catch {} }, 600);
      return;
    }
    conns[c.peer] = c;
    upsertPlayer({ id: msg.player.id, name: String(msg.player.name).slice(0, 20) || "Player", host: false });
  }
  if (msg.t === "leave") {
    lobby.players = lobby.players.filter((p) => p.id !== msg.id);
    Object.entries(conns).forEach(([k, v]) => { if (v._pid === msg.id) delete conns[k]; });
    broadcast();
  }
}

function upsertPlayer(p) {
  if (!lobby.players.some((x) => x.id === p.id)) lobby.players.push(p);
  broadcast();
}
function removePeer(peerId) {
  if (viewers[peerId]) { delete viewers[peerId]; return; }
  const c = conns[peerId];
  if (!c) return;
  delete conns[peerId];
  if (c._pid) lobby.players = lobby.players.filter((p) => p.id !== c._pid);
  broadcast();
}

function broadcast() {
  // share selected custom decks so guests (who don't have them) can play too
  if (isHost && lobby) {
    lobby.customDecks = getCustomDecks().filter((d) => lobby.decks.includes(d.id));
    saveSettings({ host: { spyCount: lobby.spyCount, decks: lobby.decks } });
  }
  renderLobby();
  if (lobby.status === "playing") renderGame();
  [...Object.values(conns), ...Object.values(viewers)].forEach((c) => {
    try { c.open && c.send({ t: "state", lobby }); } catch {}
  });
}

// ---------- CLIENT ----------
function joinGame(code, asViewer) {
  destroyPeer();
  isHost = false;
  viewing = !!asViewer;
  joinAnswered = false;
  joinFailed = false;
  wasKicked = false;
  peer = new Peer({ debug: 0 }); // random id
  peer.on("open", (id) => {
    myPeerId = id;
    hostConn = peer.connect(PEER_PREFIX + code, { reliable: true });
    const sendHello = () => {
      try { hostConn.send({ t: "hello", player: { id: myId, name: asViewer ? "Projector" : myName, viewer: !!asViewer } }); } catch {}
    };
    hostConn.on("open", () => {
      sendHello();
      setTimeout(() => { if (!joinAnswered) sendHello(); }, 1500); // retry in case it raced
    });
    hostConn.on("data", (msg) => {
      joinAnswered = true;
      if (msg.t === "state") { lobby = msg.lobby; if (viewing) renderPresent(); else enterLobby(); }
      if (msg.t === "error") { joinFailed = true; toast(msg.msg); leaveToHome(); }
      if (msg.t === "kicked") { wasKicked = true; toast("You have been kicked"); setTimeout(leaveToHome, 600); }
    });
    hostConn.on("close", () => { if (!wasKicked && !joinFailed) toast("Host left the game"); leaveToHome(); });
    hostConn.on("error", () => { toast("Could not connect — check the code"); });
    // timeout if host doesn't exist
    setTimeout(() => {
      if (!lobby && !joinFailed) toast("Still trying… check code & internet");
    }, 4000);
  });
  peer.on("error", (e) => {
    if (e.type === "peer-unavailable") toast("Lobby not found — check the code");
    else toast("Connection error: " + e.type);
  });
}

// ---------- LOBBY UI ----------
function enterLobby() {
  show("lobby");
  renderLobby();
  renderQR();
}

function renderQR() {
  const el = $("qr");
  el.innerHTML = "";
  try {
    new QRCode(el, { text: gameLink(lobby.code), width: 150, height: 150, correctLevel: QRCode.CorrectLevel.M });
  } catch { el.innerHTML = "<small>QR unavailable</small>"; }
}

function renderLobby() {
  if (!lobby) return;
  $("lobby-code").textContent = lobby.code;
  $("lobby-count").textContent = lobby.players.length + (lobby.players.length === 1 ? " player" : " players");
  $("spy-val").textContent = lobby.spyCount;

  // players
  const wrap = $("players");
  wrap.innerHTML = "";
  lobby.players.forEach((p) => {
    const div = document.createElement("div");
    div.className = "player" + (p.id === myId ? " you" : "");
    const av = document.createElement("div");
    av.className = "avatar";
    const color = `hsl(${(hash(p.id) % 360)} 70% 55%)`;
    av.style.background = color;
    av.textContent = (p.name[0] || "?").toUpperCase();
    div.appendChild(av);
    if (isHost && p.id === myId) {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.className = "pinput";
      inp.value = p.name;
      inp.maxLength = 20;
      inp.onchange = () => {
        p.name = inp.value.trim().slice(0, 20) || "Host";
        myName = p.name;
        saveSettings({ name: myName });
        broadcast();
      };
      div.appendChild(inp);
    } else {
      const nm = document.createElement("span");
      nm.textContent = p.name;
      div.appendChild(nm);
    }
    if (p.host) {
      const tag = document.createElement("span"); tag.className = "tag"; tag.textContent = "HOST";
      div.appendChild(tag);
    } else if (p.id === myId) {
      const tag = document.createElement("span"); tag.className = "tag"; tag.textContent = "YOU";
      div.appendChild(tag);
    } else if (isHost) {
      const k = document.createElement("button"); k.className = "kick"; k.textContent = "×"; k.title = "Remove";
      k.onclick = () => {
        const entry = Object.entries(conns).find(([, c]) => c._pid === p.id);
        if (entry) { try { entry[1].send({ t: "kicked" }); } catch {} setTimeout(() => { try { entry[1].close(); } catch {} }, 500); }
        lobby.players = lobby.players.filter((x) => x.id !== p.id);
        broadcast();
      };
      div.appendChild(k);
    }
    wrap.appendChild(div);
  });

  // host controls vs guest view
  $("host-controls").style.display = isHost ? "block" : "none";
  $("guest-note").style.display = isHost ? "none" : "block";
  $("btn-start").style.display = isHost ? "block" : "none";

  // decks (tap to preview locations, toggle to include)
  const dw = $("decks");
  dw.innerHTML = "";
  allDecks(lobby.customDecks).forEach((d) => {
    const on = lobby.decks.includes(d.id);
    const open = expandedDecks.has(d.id);
    const el = document.createElement("div");
    el.className = "deck" + (on ? " on" : "") + (open ? " open" : "");
    const head = document.createElement("div");
    head.className = "deck-head";
    head.innerHTML = `<div><b>${esc(d.name)}${d.custom ? ' <span class="ctag">CUSTOM</span>' : ""}</b><small>${d.locations.length} locations • ${esc(d.desc || "")}</small></div><span class="chev">›</span>`;
    if (isHost) {
      const t = document.createElement("button");
      t.className = "toggle";
      t.setAttribute("aria-label", "Include " + d.name);
      t.onclick = (e) => {
        e.stopPropagation();
        if (on) {
          if (lobby.decks.length === 1) return toast("Keep at least 1 deck");
          lobby.decks = lobby.decks.filter((x) => x !== d.id);
        } else lobby.decks.push(d.id);
        // clamp spies
        lobby.spyCount = Math.min(lobby.spyCount, Math.max(1, lobby.players.length - 2 || 1));
        broadcast();
      };
      head.appendChild(t);
    }
    head.onclick = () => {
      open ? expandedDecks.delete(d.id) : expandedDecks.add(d.id);
      renderLobby();
    };
    el.appendChild(head);
    const prev = document.createElement("div");
    prev.className = "deck-preview";
    const prevInner = document.createElement("div");
    prevInner.className = "deck-preview-inner";
    d.locations.forEach((l) => {
      prevInner.appendChild(makeLocBlock(d.id, l.name, l.roles || [], { onToggle: renderLobby }));
    });
    prev.appendChild(prevInner);
    el.appendChild(prev);
    dw.appendChild(el);
  });

  validateStart();
  if (lobby.status === "playing") { show("game"); renderGame(); }
}

function isHostOnline() { return isHost; } // host renders via broadcast already

function validateStart() {
  const btn = $("btn-start");
  const n = lobby.players.length;
  const ok = n >= 3;
  btn.disabled = !ok;
  btn.textContent = ok ? `Start game (${n} players)` : `Need at least 3 players (${n}/3)`;
  const maxSpies = Math.max(1, n - 2);
  if (lobby.spyCount > maxSpies && isHost) { lobby.spyCount = maxSpies; $("spy-val").textContent = lobby.spyCount; }
  $("spy-hint").textContent = `1 – ${maxSpies} spies for ${n} players`;
}

$("spy-minus").onclick = () => { if (!isHost) return; lobby.spyCount = Math.max(1, lobby.spyCount - 1); broadcast(); };
$("spy-plus").onclick = () => {
  if (!isHost) return;
  const max = Math.max(1, lobby.players.length - 2);
  if (lobby.spyCount >= max) return toast("Too many spies for " + lobby.players.length + " players");
  lobby.spyCount++;
  broadcast();
};
$("btn-copy-code").onclick = async () => { await copyText(lobby.code); toast("Code copied"); };
$("btn-copy-link").onclick = async () => { await copyText(gameLink(lobby.code)); toast("Invite link copied"); };
$("btn-leave").onclick = () => {
  if (!isHost && hostConn) try { hostConn.send({ t: "leave", id: myId }); } catch {}
  leaveToHome();
};
function leaveToHome() { destroyPeer(); lobby = null; viewing = false; wasKicked = false; revealed = false; show("home"); }

async function copyText(t) {
  try { await navigator.clipboard.writeText(t); }
  catch {
    const ta = document.createElement("textarea");
    ta.value = t; document.body.appendChild(ta); ta.select();
    document.execCommand("copy"); ta.remove();
  }
}

// ---------- GAME ----------
$("btn-start").onclick = () => {
  const n = lobby.players.length;
  if (n < 3) return toast("Need at least 3 players");
  const pool = allLocations(lobby.decks, lobby.customDecks);
  if (!pool.length) return toast("Select at least 1 deck");
  const loc = pool[Math.floor(Math.random() * pool.length)];
  const roles = shuffle([...loc.roles]);
  const order = shuffle([...lobby.players]);
  const spies = new Set(order.slice(0, lobby.spyCount).map((p) => p.id));
  const assignments = {};
  let ri = 0;
  order.forEach((p) => {
    assignments[p.id] = spies.has(p.id)
      ? { spy: true, role: "SPY", location: null }
      : { spy: false, role: roles[ri++ % roles.length], location: loc.name };
  });
  lobby.status = "playing";
  lobby.reveal = false;
  lobby.round = {
    location: loc.name,
    assignments,
  };
  lobby.turn = { order: shuffle(lobby.players.map((p) => p.id)), idx: 0 };
  lobby.revealInfo = null;
  revealed = false; suspect = null; spyGuess = null;
  broadcast();
  toast("Roles dealt — tap your card");
};

function myAssignment() {
  if (offline) return offline.assignments[myId];
  return lobby?.round?.assignments?.[myId];
}

// turn order: everyone asks once, then the order loops
function turnInfo() {
  if (!lobby || !lobby.turn || !lobby.turn.order) return null;
  const order = lobby.turn.order.filter((id) => lobby.players.some((p) => p.id === id));
  if (!order.length) return null;
  const pos = lobby.turn.idx % order.length;
  return {
    order,
    current: order[pos],
    next: order[(pos + 1) % order.length],
    round: Math.floor(lobby.turn.idx / order.length) + 1,
    pos: pos + 1,
    total: order.length,
  };
}
$("btn-next-turn").onclick = () => {
  if (!isHost || !lobby || !lobby.turn) return;
  lobby.turn.idx++;
  broadcast();
  toast("Next turn");
};

// ---------- PRESENTER (projector screen, watch-only) ----------
let lastPresentCode = null;
function renderPresent() {
  if (!lobby) return;
  show("present");
  const playing = lobby.status === "playing" && turnInfo();
  $("present-lobby-wrap").style.display = playing ? "none" : "";
  $("present-game-wrap").style.display = playing ? "" : "none";
  if (!playing) {
    $("present-code").textContent = lobby.code;
    if (lastPresentCode !== lobby.code) {
      lastPresentCode = lobby.code;
      const el = $("present-qr");
      el.innerHTML = "";
      try {
        new QRCode(el, { text: gameLink(lobby.code), width: 200, height: 200, correctLevel: QRCode.CorrectLevel.M });
      } catch { el.innerHTML = "<small>QR unavailable</small>"; }
    }
    const n = lobby.players.length;
    $("present-count").textContent = n + (n === 1 ? " player joined" : " players joined");
  } else {
    const ti = turnInfo();
    if (!ti) return;
    const ri = lobby.revealInfo;
    $("present-reveal").style.display = ri ? "block" : "none";
    if (ri) {
      $("present-reveal-loc").textContent = ri.location;
      $("present-reveal-spies").textContent = (ri.spies.length === 1 ? "Spy: " : "Spies: ") + ri.spies.join(", ");
    }
    $("present-turn").textContent = nameOf(ti.current);
    $("present-meta").textContent = `Question ${ti.pos} of ${ti.total} • Round ${ti.round}`;
    $("present-next").textContent = "Up next: " + nameOf(ti.next);
    const order = $("present-order");
    order.innerHTML = "";
    ti.order.forEach((id) => {
      const s = document.createElement("span");
      s.className = "vote-chip" + (id === ti.current ? " sel" : "");
      s.textContent = (id === ti.current ? "● " : "") + nameOf(id);
      order.appendChild(s);
    });
    const grid = $("present-locs");
    grid.innerHTML = "";
    allLocations(lobby.decks, lobby.customDecks).forEach((l) => {
      const s = document.createElement("span");
      s.className = "vote-chip";
      s.textContent = l.name;
      grid.appendChild(s);
    });
  }
}
$("btn-present-leave").onclick = () => leaveToHome();

function renderGame() {
  show("game");
  const a = myAssignment();
  if (!a) return;
  revealed = false;
  paintCard(false);
  // role card must always tap-to-reveal (offline pass-and-play rebinds it)
  $("role-card").onclick = () => { revealed = !revealed; paintCard(revealed); };
  // players
  const me = (offline ? offline.players : lobby.players);
  const wrap = $("game-players");
  wrap.innerHTML = "";
  me.forEach((p) => {
    if (p.id === myId) return;
    const b = document.createElement("button");
    b.className = "vote-chip" + (suspect === p.id ? " sel" : "");
    b.textContent = p.name;
    b.onclick = () => { suspect = suspect === p.id ? null : p.id; renderGamePlayersOnly(); };
    wrap.appendChild(b);
  });
  // locations grid
  const pool = offline ? offline.pool : allLocations(lobby.decks, lobby.customDecks);
  const grid = $("loc-grid");
  grid.innerHTML = "";
  const isSpy = a.spy;
  pool.forEach((l) => {
    const mine = !isSpy && l.name === a.location;
    grid.appendChild(makeLocBlock("game-" + (l.deck || ""), l.name, l.roles || [], {
      mine,
      marker: mine ? "● " : "",
      selected: spyGuess === l.name,
      selectable: isSpy,
      onSelect: () => { spyGuess = spyGuess === l.name ? null : l.name; renderGame(); },
      onToggle: renderGame,
    }));
  });
  $("spy-guess-box").style.display = isSpy ? "block" : "none";
  $("nonspy-note").style.display = isSpy ? "none" : "block";
  $("btn-new-round").style.display = isHost || offline ? "block" : "none";
  $("btn-reveal").style.display = isHost || offline ? "block" : "none";
  $("suspects-card").style.display = "block";
  $("locations-card").style.display = "block";
  // host revealed — show it to guests too
  if (!offline && !isHost && lobby.revealInfo && lobby.revealInfo.at !== seenRevealAt) {
    seenRevealAt = lobby.revealInfo.at;
    openRevealModal(lobby.revealInfo.location, lobby.revealInfo.spies, "");
  }
  // host-only advance; turn display lives on the projector screen
  $("btn-next-turn").style.display = isHost && !offline && lobby.turn ? "block" : "none";
  $("game-code-lbl").textContent = offline ? "Offline mode" : "Lobby " + lobby.code;
}

function renderGamePlayersOnly() { renderGame(); }

function paintCard(showIt) {
  const a = myAssignment();
  const card = $("role-card");
  if (!showIt) {
    card.className = "glass role-card";
    card.innerHTML = `<div class="hidden-face">` + SVG_EYE + `</div><h3>Tap to reveal</h3><div class="tap">Keep it secret — show only to you</div>`;
    return;
  }
  if (a.spy) {
    card.className = "glass role-card spy-card";
    card.innerHTML = `<div class="hidden-face">` + SVG_EYE_OFF + `</div><h3>YOU ARE THE SPY</h3>
      <div class="tap">No location. Blend in, ask questions,<br>then guess the location below to win.</div>`;
  } else {
    card.className = "glass role-card loc-card";
    card.innerHTML = `<div style="font-size:13px;font-weight:700;opacity:.8">LOCATION</div><h3>${esc(a.location)}</h3>
      <div style="font-size:13px;font-weight:700;opacity:.8;margin-top:10px">YOUR ROLE</div>
      <div style="font-size:20px;font-weight:800">${esc(a.role)}</div>
      <div class="tap" style="margin-top:10px">Tap to hide</div>`;
  }
}
$("role-card").onclick = () => { revealed = !revealed; paintCard(revealed); };

$("btn-reveal").onclick = () => {
  const a = myAssignment();
  const players = offline ? offline.players : lobby.players;
  const round = offline ? { location: offline.location } : lobby.round;
  const spies = players.filter((p) => (offline ? offline.assignments[p.id].spy : lobby.round.assignments[p.id].spy));
  openRevealModal(
    round.location,
    spies.map((s) => s.name),
    `<div style="color:rgba(255,255,255,.7);font-size:13.5px">Your role: <b style="color:#fff">${a.spy ? "SPY" : esc(a.role) + " @ " + esc(a.location)}</b></div>
     ${suspect ? `<div style="margin-top:8px;font-size:14px">You suspect: <b>${esc(nameOf(suspect))}</b></div>` : ""}
     ${spyGuess ? `<div style="margin-top:8px;font-size:14px">Spy guesses: <b>${esc(spyGuess)}</b></div>` : ""}`
  );
  if (!offline && isHost) {
    lobby.revealInfo = { location: round.location, spies: spies.map((s) => s.name), at: Date.now() };
    seenRevealAt = lobby.revealInfo.at;
    broadcast();
  }
};
let seenRevealAt = 0;
function openRevealModal(location, spyNames, extraHTML) {
  $("reveal-body").innerHTML =
    `<div class="pill">${esc(location)}</div>
     <div style="margin:12px 0 6px;font-weight:800">${spyNames.length === 1 ? "Spy" : "Spies"}: ${spyNames.map((s) => esc(s)).join(", ")}</div>` +
    (extraHTML || "");
  $("modal").classList.add("show");
}
$("modal-close").onclick = () => $("modal").classList.remove("show");
$("modal").onclick = (e) => { if (e.target.id === "modal") e.currentTarget.classList.remove("show"); };

$("btn-new-round").onclick = () => {
  if (offline) return startOfflineRound();
  if (!isHost) return;
  // back to lobby for new settings, keep players
  lobby.status = "lobby";
  lobby.round = null;
  lobby.revealInfo = null;
  broadcast();
  show("lobby");
};
$("btn-end").onclick = () => {
  if (offline) { offline = null; show("home"); return; }
  if (isHost) { lobby.status = "lobby"; lobby.round = null; broadcast(); show("lobby"); }
  else { if (hostConn) try { hostConn.send({ t: "leave", id: myId }); } catch {} leaveToHome(); }
};

// ---------- OFFLINE SETUP (same-device) ----------
let offline = null;
let setupPlayers = [];
let setupSpies = 1;
let setupDecks = [];

function maxSetupSpies() { return Math.max(1, setupPlayers.length - 2); }

function renderSetup() {
  setupSpies = Math.min(setupSpies, maxSetupSpies());
  saveSettings({ setup: { players: setupPlayers, spies: setupSpies, decks: setupDecks } });

  // players — editable names, add/remove
  const wrap = $("setup-players");
  wrap.innerHTML = "";
  setupPlayers.forEach((name, i) => {
    const div = document.createElement("div");
    div.className = "player";
    div.innerHTML = `<div class="avatar">${esc((name.trim()[0] || "?")).toUpperCase()}</div>`;
    const inp = document.createElement("input");
    inp.type = "text";
    inp.className = "pinput";
    inp.value = name;
    inp.maxLength = 20;
    inp.placeholder = "Player " + (i + 1);
    inp.onchange = () => { setupPlayers[i] = inp.value.slice(0, 20); renderSetup(); };
    div.appendChild(inp);
    if (setupPlayers.length > 3) {
      const rm = document.createElement("button");
      rm.className = "rm-btn";
      rm.textContent = "×";
      rm.title = "Remove";
      rm.onclick = () => {
        setupPlayers.splice(i, 1);
        setupSpies = Math.min(setupSpies, maxSetupSpies());
        renderSetup();
      };
      div.appendChild(rm);
    }
    wrap.appendChild(div);
  });
  $("btn-add-player").style.display = setupPlayers.length >= 12 ? "none" : "block";

  // spies stepper
  $("setup-spy-val").textContent = setupSpies;
  $("setup-spy-hint").textContent = `1 – ${maxSetupSpies()} spies for ${setupPlayers.length} players`;

  // decks with preview
  const dw = $("setup-decks");
  dw.innerHTML = "";
  allDecks().forEach((d) => {
    const on = setupDecks.includes(d.id);
    const open = expandedDecks.has("setup-" + d.id);
    const el = document.createElement("div");
    el.className = "deck" + (on ? " on" : "") + (open ? " open" : "");
    const head = document.createElement("div");
    head.className = "deck-head";
    head.innerHTML = `<div><b>${esc(d.name)}${d.custom ? ' <span class="ctag">CUSTOM</span>' : ""}</b><small>${d.locations.length} locations • ${esc(d.desc || "")}</small></div><span class="chev">›</span>`;
    const t = document.createElement("button");
    t.className = "toggle";
    t.setAttribute("aria-label", "Include " + d.name);
    t.onclick = (e) => {
      e.stopPropagation();
      if (on) {
        if (setupDecks.length === 1) return toast("Keep at least 1 deck");
        setupDecks = setupDecks.filter((x) => x !== d.id);
      } else setupDecks.push(d.id);
      renderSetup();
    };
    head.appendChild(t);
    head.onclick = () => {
      open ? expandedDecks.delete("setup-" + d.id) : expandedDecks.add("setup-" + d.id);
      renderSetup();
    };
    el.appendChild(head);
    const prev = document.createElement("div");
    prev.className = "deck-preview";
    const prevInner = document.createElement("div");
    prevInner.className = "deck-preview-inner";
    d.locations.forEach((l) => {
      prevInner.appendChild(makeLocBlock("setup-" + d.id, l.name, l.roles || [], { onToggle: renderSetup }));
    });
    prev.appendChild(prevInner);
    el.appendChild(prev);
    dw.appendChild(el);
  });

  $("btn-start-offline").textContent = `Start game (${setupPlayers.length} players)`;
}

$("btn-add-player").onclick = () => {
  if (setupPlayers.length >= 12) return toast("Max 12 players");
  setupPlayers.push("Player " + (setupPlayers.length + 1));
  renderSetup();
};
$("setup-spy-minus").onclick = () => { setupSpies = Math.max(1, setupSpies - 1); renderSetup(); };
$("setup-spy-plus").onclick = () => {
  if (setupSpies >= maxSetupSpies()) return toast("Too many spies for " + setupPlayers.length + " players");
  setupSpies++;
  renderSetup();
};
$("btn-start-offline").onclick = () => {
  if (!setupDecks.length) return toast("Select at least 1 deck");
  const names = setupPlayers.map((n, i) => n.trim() || "Player " + (i + 1));
  offline = {
    players: names.map((n, i) => ({ id: "off" + i, name: n })),
    pool: allLocations(setupDecks),
    spyCount: Math.min(setupSpies, names.length - 2),
    assignments: {},
    location: null,
    idx: 0,
  };
  startOfflineRound();
};
function startOfflineRound() {
  const loc = offline.pool[Math.floor(Math.random() * offline.pool.length)];
  const roles = shuffle([...loc.roles]);
  const order = shuffle([...offline.players]);
  const spies = new Set(order.slice(0, offline.spyCount).map((p) => p.id));
  offline.location = loc.name;
  offline.assignments = {};
  let ri = 0;
  order.forEach((p) => {
    offline.assignments[p.id] = spies.has(p.id)
      ? { spy: true, role: "SPY", location: null }
      : { spy: false, role: roles[ri++ % roles.length], location: loc.name };
  });
  // pass-and-play order: walk through players one by one
  offline.idx = 0;
  myId = offline.players[0].id; // we reuse myId as "current viewer"
  passDevice(0);
}
function passDevice(i) {
  show("game");
  $("game-code-lbl").textContent = "Offline • pass & play";
  $("btn-new-round").style.display = "block";
  $("btn-reveal").style.display = "none";
  $("suspects-card").style.display = "none";
  $("locations-card").style.display = "none";
  $("spy-guess-box").style.display = "none";
  $("nonspy-note").style.display = "none";
  const p = offline.players[i];
  myId = p.id;
  const card = $("role-card");
  card.className = "glass role-card";
  card.innerHTML = `<div class="hidden-face">` + SVG_SWAP + `</div><h3>Pass to ${esc(p.name)}</h3><div class="tap">Tap when ${esc(p.name)} is holding the phone</div>`;
  let step = 0;
  card.onclick = () => {
    if (step === 0) {
      const a = offline.assignments[p.id];
      if (a.spy) {
        card.className = "glass role-card spy-card";
        card.innerHTML = `<div class="hidden-face">` + SVG_EYE_OFF + `</div><h3>YOU ARE THE SPY</h3><div class="tap">Tap when done — pass on</div>`;
      } else {
        card.className = "glass role-card loc-card";
        card.innerHTML = `<div style="font-size:13px;font-weight:700;opacity:.8">LOCATION</div><h3>${esc(a.location)}</h3><div style="font-size:13px;font-weight:700;opacity:.8;margin-top:10px">YOUR ROLE</div><div style="font-size:20px;font-weight:800">${esc(a.role)}</div><div class="tap" style="margin-top:10px">Tap when done — pass on</div>`;
      }
      step = 1;
    } else {
      if (i + 1 < offline.players.length) passDevice(i + 1);
      else {
        // all seen — show generic play screen
        card.onclick = null;
        myId = offline.players[0].id;
        card.className = "glass role-card";
        card.innerHTML = `<div class="hidden-face">` + SVG_CHECK + `</div><h3>Everyone knows their role</h3><div class="tap">Start asking questions! Location was dealt.</div>`;
        card.onclick = () => toast("Roles already dealt");
        $("suspects-card").style.display = "block";
        $("locations-card").style.display = "block";
        $("btn-reveal").style.display = "block";
        const grid = $("loc-grid"); grid.innerHTML = "";
        const paintOfflineGrid = () => {
          grid.innerHTML = "";
          offline.pool.forEach((x) => {
            grid.appendChild(makeLocBlock("game-" + (x.deck || ""), x.name, x.roles || [], { onToggle: paintOfflineGrid }));
          });
        };
        paintOfflineGrid();
        const wrap = $("game-players"); wrap.innerHTML = "";
        offline.players.forEach((p2) => {
          const b = document.createElement("button");
          b.className = "vote-chip"; b.textContent = p2.name;
          b.onclick = () => { b.classList.toggle("sel"); };
          wrap.appendChild(b);
        });
      }
    }
  };
  const wrap = $("game-players"); wrap.innerHTML = "";
  const grid = $("loc-grid"); grid.innerHTML = "";
}

// ---------- MANAGE DECKS (browse all, jump to custom editor) ----------
function openManage() {
  show("manage");
  renderManage();
}
function renderManage() {
  const list = $("manage-deck-list");
  list.innerHTML = "";
  allDecks().forEach((d) => {
    const open = expandedDecks.has("manage-" + d.id);
    const el = document.createElement("div");
    el.className = "deck on" + (open ? " open" : "");
    const head = document.createElement("div");
    head.className = "deck-head";
    head.innerHTML = `<div><b>${esc(d.name)}${d.custom ? ' <span class="ctag">CUSTOM</span>' : ""}</b><small>${(d.locations || []).length} locations • ${esc(d.desc || "")}</small></div><span class="chev">›</span>`;
    head.onclick = () => {
      open ? expandedDecks.delete("manage-" + d.id) : expandedDecks.add("manage-" + d.id);
      renderManage();
    };
    el.appendChild(head);
    const prev = document.createElement("div");
    prev.className = "deck-preview";
    const prevInner = document.createElement("div");
    prevInner.className = "deck-preview-inner";
    (d.locations || []).forEach((l) => {
      prevInner.appendChild(makeLocBlock("manage-" + d.id, l.name, l.roles || [], { onToggle: renderManage }));
    });
    prev.appendChild(prevInner);
    el.appendChild(prev);
    list.appendChild(el);
  });
}

// ---------- CUSTOM DECK MANAGER ----------
let customReturnTo = "home";
let editingDeckId = null;

function openCustom(from) {
  customReturnTo = from || "home";
  editingDeckId = null;
  show("custom");
  renderCustom();
}
$("btn-manage-home").onclick = () => openManage("home");
$("btn-custom-from-manage").onclick = () => openCustom("manage");
$("btn-back-manage").onclick = () => show("home");
$("btn-custom-from-lobby").onclick = () => openCustom("lobby");
$("btn-custom-from-setup").onclick = () => openCustom("setup");
$("btn-back-custom").onclick = () => {
  editingDeckId = null;
  if (customReturnTo === "lobby" && lobby) { show("lobby"); renderLobby(); }
  else if (customReturnTo === "setup") { show("setup"); renderSetup(); }
  else if (customReturnTo === "manage") { show("manage"); renderManage(); }
  else show("home");
};

function getDeck(id) { return getCustomDecks().find((d) => d.id === id); }
// persistent refs — the edit panel gets reparented under the open deck,
// so ID lookups would fail after list re-renders
const editWrapEl = $("custom-edit-wrap");
const editLocListEl = $("custom-loc-list");
function mutateDecks(fn) {
  const decks = getCustomDecks();
  fn(decks);
  saveCustomDecks(decks);
  return decks;
}

$("btn-create-deck").onclick = () => {
  const name = $("new-deck-name").value.trim().slice(0, 24);  if (!name) return toast("Name your deck first");
  const deck = { id: "c_" + Math.random().toString(36).slice(2, 9), name, desc: "Custom deck", locations: [], custom: true };
  const decks = getCustomDecks();
  decks.push(deck);
  saveCustomDecks(decks);
  $("new-deck-name").value = "";
  editingDeckId = deck.id;
  renderCustom();
  toast("Deck created — add locations");
};
$("new-deck-name").onkeydown = (e) => { if (e.key === "Enter") $("btn-create-deck").click(); };

function renderCustom() {
  const decks = getCustomDecks();
  const list = $("custom-deck-list");
  list.innerHTML = "";
  if (!decks.length) {
    list.innerHTML = `<p class="sub" style="margin:4px 0 0">No custom decks yet. Create one below — e.g. "Office", "Family", "Movies".</p>`;
  }
  let openEl = null;
  decks.forEach((d) => {
    const el = document.createElement("div");
    el.className = "deck on" + (editingDeckId === d.id ? " open" : "");
    const head = document.createElement("div");
    head.className = "deck-head";
    const nameWrap = document.createElement("div");
    const nameInp = document.createElement("input");
    nameInp.type = "text"; nameInp.maxLength = 24;
    nameInp.className = "deck-name-input";
    nameInp.value = d.name;
    nameInp.placeholder = "Deck name";
    nameInp.onclick = (e) => e.stopPropagation();
    nameInp.onchange = () => {
      const v = nameInp.value.trim().slice(0, 24);
      if (v) mutateDecks((ds) => { ds.find((x) => x.id === d.id).name = v; });
      renderCustom();
    };
    const count = document.createElement("small");
    count.textContent = (d.locations || []).length + " locations";
    if (editingDeckId !== d.id) { const b = document.createElement("b"); b.textContent = d.name; nameWrap.appendChild(b); } else { nameWrap.appendChild(nameInp); }
    nameWrap.appendChild(count);
    const chev = document.createElement("span");
    chev.className = "chev";
    chev.textContent = "›";
    head.appendChild(nameWrap);
    head.appendChild(chev);
    head.onclick = () => { editingDeckId = editingDeckId === d.id ? null : d.id; renderCustom(); };
    el.appendChild(head);
    if (editingDeckId === d.id) openEl = el;
    list.appendChild(el);
  });

  // edit panel — lives inside the open deck, not in a separate card
  const wrap = editWrapEl;
  const deck = editingDeckId && getDeck(editingDeckId);
  if (!deck) { wrap.style.display = "none"; return; }
  wrap.style.display = "block";
  if (openEl) openEl.appendChild(wrap);
  const ll = editLocListEl;
  ll.innerHTML = "";
  (deck.locations || []).forEach((loc, li) => {
    const box = document.createElement("div");
    box.className = "cloc";
    const h = document.createElement("div");
    h.className = "cloc-head";
    const nm = document.createElement("input");
    nm.type = "text"; nm.value = loc.name || ""; nm.maxLength = 30;
    nm.className = "loc-name";
    nm.placeholder = "Location name";
    nm.onchange = () => {
      mutateDecks((ds) => { ds.find((x) => x.id === deck.id).locations[li].name = nm.value.slice(0, 30); });
      renderCustom();
    };
    const del = document.createElement("button");
    del.className = "rm-btn"; del.textContent = "×"; del.title = "Delete location";
    del.onclick = () => {
      mutateDecks((ds) => { ds.find((x) => x.id === deck.id).locations.splice(li, 1); });
      renderCustom();
    };
    h.appendChild(nm); h.appendChild(del);
    box.appendChild(h);
    const rolesLbl = document.createElement("label");
    rolesLbl.className = "lbl";
    rolesLbl.textContent = "Roles (" + (loc.roles || []).length + ")";
    box.appendChild(rolesLbl);
    const rolesBox = document.createElement("div");
    rolesBox.className = "cloc-roles";
    (loc.roles || []).forEach((r, ri) => {
      const row = document.createElement("div");
      row.className = "role-row";
      const inp = document.createElement("input");
      inp.type = "text"; inp.value = r; inp.maxLength = 30;
      inp.placeholder = "Role " + (ri + 1);
      inp.onchange = () => {
        mutateDecks((ds) => { ds.find((x) => x.id === deck.id).locations[li].roles[ri] = inp.value.slice(0, 30); });
        renderCustom();
      };
      const rm = document.createElement("button");
      rm.className = "rm-btn"; rm.textContent = "×"; rm.title = "Remove role";
      rm.onclick = () => {
        mutateDecks((ds) => { ds.find((x) => x.id === deck.id).locations[li].roles.splice(ri, 1); });
        renderCustom();
      };
      row.appendChild(inp); row.appendChild(rm);
      rolesBox.appendChild(row);
    });
    const addR = document.createElement("button");
    addR.className = "btn btn-small"; addR.style.marginTop = "8px";
    addR.textContent = "+ Role";
    addR.onclick = () => {
      mutateDecks((ds) => { ds.find((x) => x.id === deck.id).locations[li].roles.push(""); });
      renderCustom();
    };
    rolesBox.appendChild(addR);
    box.appendChild(rolesBox);
    ll.appendChild(box);
  });
}

$("btn-add-location").onclick = () => {
  if (!editingDeckId) return;
  mutateDecks((ds) => { ds.find((x) => x.id === editingDeckId).locations.push({ name: "", roles: [""] }); });
  renderCustom();
};
$("btn-delete-deck").onclick = () => {
  if (!editingDeckId) return;
  const deck = getDeck(editingDeckId);
  const id = editingDeckId;
  askConfirm("Delete deck?", `"${deck ? deck.name : "This deck"}" and all its locations and roles will be permanently removed from this device.`, "Delete", () => {
    mutateDecks((ds) => { const i = ds.findIndex((x) => x.id === id); if (i >= 0) ds.splice(i, 1); });
    editingDeckId = null;
    renderCustom();
    toast("Deck deleted");
  });
};

// ---------- utils ----------
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; } return a; }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
function nameOf(id) {
  const list = offline ? offline.players : lobby.players;
  return (list.find((p) => p.id === id) || {}).name || "?";
}

// QR joins: code in URL goes straight to the join screen, name prefilled
window.addEventListener("DOMContentLoaded", () => {
  const savedName = loadSettings().name;
  const pre = new URLSearchParams(location.search).get("code");
  if (pre) {
    $("code-input").value = pre.toUpperCase().slice(0, 5);
    $("join-name").value = savedName || "";
    show("join");
    if (!savedName) setTimeout(() => $("join-name").focus(), 300);
  } else {
    show("home");
  }
});
