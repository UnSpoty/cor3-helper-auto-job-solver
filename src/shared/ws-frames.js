// src/shared/ws-frames.js
// Socket.IO v4 frame parser/encoder, used by the WS interceptor and any
// module that needs to decode raw WS payloads.
// Registers into globalThis.COR3.wsFrames.
//
// Socket.IO v4 frame reference:
//   '0'           Connect (engine.io-level)
//   '1'           Disconnect
//   '2'           Ping
//   '3'           Pong
//   '4<msg>'      Message (Socket.IO message follows)
//   '40'          Connect (Socket.IO-level)
//   '41'          Disconnect (Socket.IO-level)
//   '42<json>'    Event:    JSON.parse → [eventName, ...args]
//   '43<id><json>' Ack:     ack id followed by JSON args
// We only care about '42' frames in practice — those are the named events.

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    root.COR3 = root.COR3 || {};
    if (root.COR3.wsFrames) return;

    /**
     * Parse a raw WS frame string. Returns null if not an event frame.
     * @param {string} raw
     * @returns {{ engineType: number, sioType: number|null, eventName: string|null, payload: any|null, ackId: number|null } | null}
     */
    function parseFrame(raw) {
        if (typeof raw !== 'string' || raw.length === 0) return null;
        const engineType = Number(raw[0]);
        if (Number.isNaN(engineType)) return null;

        // Engine.io types 0..3 = open/close/ping/pong, no Socket.IO payload
        if (engineType !== 4) {
            return { engineType, sioType: null, eventName: null, payload: null, ackId: null };
        }

        // engine type 4 = "message", followed by Socket.IO frame
        const sio = raw.slice(1);
        if (sio.length === 0) return null;
        const sioType = Number(sio[0]);
        if (Number.isNaN(sioType)) return null;

        // sio type 0/1 = connect/disconnect (with optional namespace)
        // sio type 2 = event,  3 = ack
        if (sioType !== 2 && sioType !== 3) {
            return { engineType, sioType, eventName: null, payload: null, ackId: null };
        }

        // After the type byte, optional ack id (digits) before the JSON array
        let body = sio.slice(1);
        let ackId = null;
        const m = /^(\d+)/.exec(body);
        if (m) {
            ackId = Number(m[1]);
            body = body.slice(m[0].length);
        }
        if (body.length === 0) return null;

        let parsed;
        try { parsed = JSON.parse(body); }
        catch (_) { return null; }
        if (!Array.isArray(parsed) || parsed.length === 0) return null;

        const eventName = sioType === 2 ? String(parsed[0]) : null;
        const payload = sioType === 2 ? (parsed.length > 1 ? parsed[1] : null) : parsed;

        return { engineType, sioType, eventName, payload, ackId };
    }

    /**
     * Encode an event frame for sending: '42[eventName, payload]'.
     */
    function encodeEvent(eventName, payload) {
        const arr = payload === undefined ? [eventName] : [eventName, payload];
        return '42' + JSON.stringify(arr);
    }

    /**
     * Cheap fast-path for hot loops: returns true if `raw` is a Socket.IO
     * event frame (starts with '42'). Saves a parse when caller doesn't care
     * about other frame types.
     */
    function isEventFrame(raw) {
        return typeof raw === 'string' && raw.startsWith('42');
    }

    root.COR3.wsFrames = { parseFrame, encodeEvent, isEventFrame };
})();
