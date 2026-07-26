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

    ws.on("close", () => {
        queue = queue.filter((s) => s !== ws);
        const r = rooms.get(ws.room);
        if (!r) return;
        const peer = ws.isHost ? r.guest : r.host;
        rooms.delete(ws.room);
        sendJson(peer, { cmd: "partner_left" });
    });
});

console.log("Bomb Appetit relay listening on port", port);
