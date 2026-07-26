// Bomb Appetit — tiny relay server (room codes + quick match, 2 players per room)
const { WebSocketServer } = require("ws");
const port = process.env.PORT || 8080;
const wss = new WebSocketServer({ port });
const rooms = new Map(); // code -> { host, guest }
let queue = [];          // sockets waiting for Quick Match

const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I/O to avoid confusion
function makeCode() {
    let c = "";
    for (let i = 0; i < 4; i++) c += ALPHA[Math.floor(Math.random() * ALPHA.length)];
    return rooms.has(c) ? makeCode() : c;
}

function sendJson(ws, obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj) + "\0");
}

function pairUp(hostWs, guestWs) {
    const code = makeCode();
    rooms.set(code, { host: hostWs, guest: guestWs });
    hostWs.room = code;  hostWs.isHost = true;
    guestWs.room = code; guestWs.isHost = false;
    sendJson(hostWs, { cmd: "paired", isHost: true });
    sendJson(guestWs, { cmd: "paired", isHost: false });
}

// A room whose host socket has quietly died (free-tier hosts like Render can
// drop a WebSocket that's sat idle too long — exactly what happens while a
// host is just sitting on "Room code: XXXX" waiting for a friend to type it
// in) leaves a stale entry in `rooms` with no clean disconnect ever firing.
// Without this, a joiner can still "successfully" pair against that dead
// host: they get a real "paired" message, the host gets nothing, and nobody
// sees an error. This nukes the stale room instead of pretending it's live.
function cleanupSocket(ws) {
    queue = queue.filter((s) => s !== ws);
    const r = rooms.get(ws.room);
    if (!r) return;
    const peer = ws.isHost ? r.guest : r.host;
    rooms.delete(ws.room);
    sendJson(peer, { cmd: "partner_left" });
}

wss.on("connection", (ws) => {
    ws.on("message", (data) => {
        let m = null;
        try {
            m = JSON.parse(data.toString("utf8").replace(/\0+$/, ""));
        } catch (e) { /* not JSON — just relay below */ }

        // control commands (only before the socket is in a room)
        if (m && m.cmd === "host") {
            if (ws.room) { sendJson(ws, { cmd: "code", code: ws.room }); return; } // duplicate hello
            const code = makeCode();
            rooms.set(code, { host: ws, guest: null });
            ws.room = code;
            ws.isHost = true;
            sendJson(ws, { cmd: "code", code });
            return;
        }
        if (m && m.cmd === "join") {
            if (ws.room) return; // duplicate hello
            const code = String(m.code || "").toUpperCase();
            const r = rooms.get(code);
            if (!r) { sendJson(ws, { cmd: "error", msg: "No room with code " + code }); return; }
            if (!r.host || r.host.readyState !== 1) {
                // the host's connection died without us noticing yet — don't
                // let the joiner think pairing worked when the host will
                // never hear about it
                rooms.delete(code);
                sendJson(ws, { cmd: "error", msg: "Host disconnected — ask them to create a new room" });
                return;
            }
            if (r.guest) { sendJson(ws, { cmd: "error", msg: "Room " + code + " is full" }); return; }
            r.guest = ws;
            ws.room = code;
            ws.isHost = false;
            sendJson(r.host, { cmd: "paired", isHost: true });
            sendJson(ws, { cmd: "paired", isHost: false });
            return;
        }
        if (m && m.cmd === "quickmatch") {
            if (ws.room) return; // duplicate hello
            while (queue.length > 0 && queue[0].readyState !== 1) queue.shift(); // drop stale entries
            if (queue.length > 0) {
                const partner = queue.shift();
                pairUp(partner, ws);
            } else {
                queue.push(ws);
                sendJson(ws, { cmd: "searching" });
            }
            return;
        }

        // everything else: relay verbatim to the partner
        const r = rooms.get(ws.room);
        if (!r) return;
        const peer = ws.isHost ? r.guest : r.host;
        if (peer && peer.readyState === 1) peer.send(data);
    });

    ws.on("close", () => cleanupSocket(ws));
});

// Keep every connection alive and prune any that are actually dead. This is
// the real fix for "host waits, friend joins, host never finds out": a host
// idling on the waiting screen sends no traffic at all, and Render's free
// tier (and plenty of other hosts/proxies) will silently drop a WebSocket
// that's been quiet too long. Sent as a normal JSON message (not a raw
// WebSocket ping/pong control frame) — GameMaker's client already ignores
// any "cmd" it doesn't recognize, so this needs zero client-side support,
// unlike relying on GM's networking layer to transparently answer low-level
// ping frames, which isn't something to bet on without being able to test it.
const HEARTBEAT_MS = 20000;
const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.readyState === 1) sendJson(ws, { cmd: "ping" });
    });
}, HEARTBEAT_MS);

wss.on("close", () => clearInterval(heartbeatInterval));

console.log("Bomb Appetit relay listening on port", port);
