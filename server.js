// Bomb Appetit — tiny relay server (room codes, 2 players per room)
const { WebSocketServer } = require("ws");
const port = process.env.PORT || 8080;
const wss = new WebSocketServer({ port });
const rooms = new Map(); // code -> { host, guest }

const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I/O to avoid confusion
function makeCode() {
    let c = "";
    for (let i = 0; i < 4; i++) c += ALPHA[Math.floor(Math.random() * ALPHA.length)];
    return rooms.has(c) ? makeCode() : c;
}

function sendJson(ws, obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj) + "\0");
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
            sendJson(ws, { cmd: "paired" });
            sendJson(r.host, { cmd: "paired" });
            return;
        }

        // everything else: relay verbatim to the partner
        const r = rooms.get(ws.room);
        if (!r) return;
        const peer = ws.isHost ? r.guest : r.host;
        if (peer && peer.readyState === 1) peer.send(data);
    });

    ws.on("close", () => {
        const r = rooms.get(ws.room);
        if (!r) return;
        const peer = ws.isHost ? r.guest : r.host;
        rooms.delete(ws.room);
        sendJson(peer, { cmd: "partner_left" });
    });
});

console.log("Bomb Appetit relay listening on port", port);
