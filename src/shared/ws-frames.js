// src/shared/ws-frames.js
// Socket.IO v4 frame parser/encoder, used by the WS interceptor and any
// module that needs to decode raw WS payloads.
// Registers into globalThis.COR3.wsFrames.
//
// May 2026 protocol shift: cor3.gg replaced the default JSON+text parser
// with a MessagePack+binary one. Engine.io still emits its own text
// control frames ("0{...}", "2", "3") but every Socket.IO-level message
// is now an ArrayBuffer carrying msgpack-encoded { type, data, nsp }.
// We keep parseFrame/encodeEvent for legacy text fallback (handshake,
// ping/pong, dev debugging) and add the binary counterparts that the
// new interceptor uses.
//
// Wire-shape reference (post-May-2026):
//   inbound EVENT   { type:2, data:[<roomName>, <payload>], nsp:"/" }
//   inbound CONNECT { type:0, data:{sid, pid, nsp}, nsp:"/" }
//   outbound EVENT  { type:2, data:[<roomOrEvent>, <payload>], nsp:"/" }
//   outbound CONN   { type:0, data:{token:"Bearer ..."}, nsp:"/" }
//   ping/pong/open  still plain text — engine.io level

(function () {
    const root = (typeof globalThis !== 'undefined') ? globalThis : self;
    root.COR3 = root.COR3 || {};
    if (root.COR3.wsFrames) return;

    // ──────────────────────────────────────────────────────────────────────
    // Minimal MessagePack codec. Only what cor3.gg actually puts on the wire:
    // nil, bool, int (positive/negative, all int widths), float64, str, bin,
    // array, map, plus fixext (decoded as null — used by socket.io for pid).
    // No streaming — buffers are small (max payload is 1 MB per server cfg).
    // ──────────────────────────────────────────────────────────────────────
    const textEncoder = (typeof TextEncoder !== 'undefined') ? new TextEncoder() : null;
    const textDecoder = (typeof TextDecoder !== 'undefined') ? new TextDecoder('utf-8', { fatal: false }) : null;

    function mpEncode(value) {
        // Single-pass into a growable Uint8Array.
        let buf = new Uint8Array(64);
        let len = 0;

        function ensure(n) {
            if (len + n <= buf.length) return;
            let cap = buf.length * 2;
            while (cap < len + n) cap *= 2;
            const next = new Uint8Array(cap);
            next.set(buf);
            buf = next;
        }
        function w8(b)  { ensure(1); buf[len++] = b & 0xff; }
        function w16(n) { ensure(2); buf[len++] = (n >>> 8) & 0xff; buf[len++] = n & 0xff; }
        function w32(n) { ensure(4); buf[len++] = (n >>> 24) & 0xff; buf[len++] = (n >>> 16) & 0xff; buf[len++] = (n >>> 8) & 0xff; buf[len++] = n & 0xff; }
        function wF64(n) {
            ensure(8);
            const dv = new DataView(buf.buffer, buf.byteOffset + len, 8);
            dv.setFloat64(0, n, false);
            len += 8;
        }
        function wBytes(arr) { ensure(arr.length); buf.set(arr, len); len += arr.length; }

        function encOne(v) {
            if (v === null || v === undefined) { w8(0xc0); return; }
            if (v === false) { w8(0xc2); return; }
            if (v === true)  { w8(0xc3); return; }
            if (typeof v === 'number') {
                if (Number.isInteger(v) && v >= -(2 ** 31) && v <= 0xffffffff) {
                    if (v >= 0) {
                        if (v <= 0x7f)     { w8(v); }
                        else if (v <= 0xff)   { w8(0xcc); w8(v); }
                        else if (v <= 0xffff) { w8(0xcd); w16(v); }
                        else                  { w8(0xce); w32(v); }
                    } else {
                        if (v >= -32)         { w8(0x100 + v); }
                        else if (v >= -128)   { w8(0xd0); w8(v & 0xff); }
                        else if (v >= -32768) { w8(0xd1); w16(v & 0xffff); }
                        else                  { w8(0xd2); w32(v >>> 0); }
                    }
                } else {
                    w8(0xcb); wF64(v);
                }
                return;
            }
            if (typeof v === 'string') {
                const bytes = textEncoder ? textEncoder.encode(v) : new Uint8Array([...v].map((c) => c.charCodeAt(0)));
                const n = bytes.length;
                if (n <= 31)        { w8(0xa0 | n); }
                else if (n <= 0xff)   { w8(0xd9); w8(n); }
                else if (n <= 0xffff) { w8(0xda); w16(n); }
                else                  { w8(0xdb); w32(n); }
                wBytes(bytes);
                return;
            }
            if (v instanceof Uint8Array) {
                const n = v.length;
                if (n <= 0xff)        { w8(0xc4); w8(n); }
                else if (n <= 0xffff) { w8(0xc5); w16(n); }
                else                  { w8(0xc6); w32(n); }
                wBytes(v);
                return;
            }
            if (Array.isArray(v)) {
                const n = v.length;
                if (n <= 15)          { w8(0x90 | n); }
                else if (n <= 0xffff) { w8(0xdc); w16(n); }
                else                  { w8(0xdd); w32(n); }
                for (let i = 0; i < n; i++) encOne(v[i]);
                return;
            }
            if (typeof v === 'object') {
                const keys = Object.keys(v);
                const n = keys.length;
                if (n <= 15)          { w8(0x80 | n); }
                else if (n <= 0xffff) { w8(0xde); w16(n); }
                else                  { w8(0xdf); w32(n); }
                for (let i = 0; i < n; i++) { encOne(keys[i]); encOne(v[keys[i]]); }
                return;
            }
            // Anything else (function, symbol, bigint) — encode as null and
            // log loudly. The wire protocol shouldn't carry those.
            try { console.warn('[COR3.wsFrames] msgpack-encode: unsupported value, sending nil', v); } catch (_) {}
            w8(0xc0);
        }

        encOne(value);
        return buf.slice(0, len);
    }

    function mpDecode(input) {
        // Accept ArrayBuffer, Uint8Array, or DataView.
        let view, baseOffset, totalLen;
        if (input instanceof ArrayBuffer) {
            view = new DataView(input);
            baseOffset = 0;
            totalLen = input.byteLength;
        } else if (ArrayBuffer.isView(input)) {
            view = new DataView(input.buffer, input.byteOffset, input.byteLength);
            baseOffset = 0;
            totalLen = input.byteLength;
        } else {
            throw new Error('msgpack-decode: input must be ArrayBuffer or typed array');
        }
        let pos = 0;
        const u8 = new Uint8Array(view.buffer, view.byteOffset + baseOffset, totalLen);

        function r8()  { return view.getUint8(pos++); }
        function r16() { const v = view.getUint16(pos); pos += 2; return v; }
        function r32() { const v = view.getUint32(pos); pos += 4; return v; }
        function rI8() { return view.getInt8(pos++); }
        function rI16(){ const v = view.getInt16(pos); pos += 2; return v; }
        function rI32(){ const v = view.getInt32(pos); pos += 4; return v; }
        function rF32(){ const v = view.getFloat32(pos); pos += 4; return v; }
        function rF64(){ const v = view.getFloat64(pos); pos += 8; return v; }
        function rStr(n) {
            const bytes = u8.subarray(pos, pos + n);
            pos += n;
            if (textDecoder) return textDecoder.decode(bytes);
            let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return s;
        }
        function rBin(n) {
            const slice = u8.slice(pos, pos + n);
            pos += n;
            return slice;
        }
        function rArr(n) { const out = new Array(n); for (let i = 0; i < n; i++) out[i] = decOne(); return out; }
        function rMap(n) { const out = {}; for (let i = 0; i < n; i++) { const k = decOne(); out[k] = decOne(); } return out; }

        function decOne() {
            const b = r8();
            if (b <= 0x7f) return b;             // positive fixint
            if (b >= 0xe0) return b - 0x100;     // negative fixint
            if (b >= 0xa0 && b <= 0xbf) return rStr(b & 0x1f);
            if (b >= 0x90 && b <= 0x9f) return rArr(b & 0x0f);
            if (b >= 0x80 && b <= 0x8f) return rMap(b & 0x0f);
            switch (b) {
                case 0xc0: return null;
                case 0xc2: return false;
                case 0xc3: return true;
                case 0xc4: return rBin(r8());
                case 0xc5: return rBin(r16());
                case 0xc6: return rBin(r32());
                case 0xca: return rF32();
                case 0xcb: return rF64();
                case 0xcc: return r8();
                case 0xcd: return r16();
                case 0xce: return r32();
                case 0xcf: { const hi = r32(); const lo = r32(); return hi * 0x100000000 + lo; }
                case 0xd0: return rI8();
                case 0xd1: return rI16();
                case 0xd2: return rI32();
                case 0xd3: {
                    const hi = rI32(); const lo = r32();
                    // 53-bit safe approximation for signed 64-bit. Cor3.gg
                    // doesn't put values beyond JS safe integer on the wire.
                    return hi * 0x100000000 + lo;
                }
                case 0xd9: return rStr(r8());
                case 0xda: return rStr(r16());
                case 0xdb: return rStr(r32());
                case 0xdc: return rArr(r16());
                case 0xdd: return rArr(r32());
                case 0xde: return rMap(r16());
                case 0xdf: return rMap(r32());
                // fixext 1/2/4/8/16 — socket.io uses ext type 0 to mark
                // null-ish placeholders (e.g. pid). Skip data, return null.
                case 0xd4: pos += 1 + 1; return null;
                case 0xd5: pos += 1 + 2; return null;
                case 0xd6: pos += 1 + 4; return null;
                case 0xd7: pos += 1 + 8; return null;
                case 0xd8: pos += 1 + 16; return null;
                // ext 8/16/32 — variable.
                case 0xc7: { const n = r8(); pos += 1 + n; return null; }
                case 0xc8: { const n = r16(); pos += 1 + n; return null; }
                case 0xc9: { const n = r32(); pos += 1 + n; return null; }
            }
            throw new Error('msgpack-decode: unknown marker 0x' + b.toString(16));
        }
        return decOne();
    }

    // ──────────────────────────────────────────────────────────────────────
    // Legacy text parser (engine.io 4 / socket.io 4 over JSON text). Used
    // only for cor3.gg's residual text frames (engine.io open / ping / pong)
    // and as a unit-test convenience.
    // ──────────────────────────────────────────────────────────────────────
    function parseFrame(raw) {
        if (typeof raw !== 'string' || raw.length === 0) return null;
        const engineType = Number(raw[0]);
        if (Number.isNaN(engineType)) return null;
        if (engineType !== 4) {
            return { engineType, sioType: null, eventName: null, payload: null, ackId: null };
        }
        const sio = raw.slice(1);
        if (sio.length === 0) return null;
        const sioType = Number(sio[0]);
        if (Number.isNaN(sioType)) return null;
        if (sioType !== 2 && sioType !== 3) {
            return { engineType, sioType, eventName: null, payload: null, ackId: null };
        }
        let body = sio.slice(1);
        let ackId = null;
        const m = /^(\d+)/.exec(body);
        if (m) { ackId = Number(m[1]); body = body.slice(m[0].length); }
        if (body.length === 0) return null;
        let parsed;
        try { parsed = JSON.parse(body); } catch (_) { return null; }
        if (!Array.isArray(parsed) || parsed.length === 0) return null;
        const eventName = sioType === 2 ? String(parsed[0]) : null;
        const payload = sioType === 2 ? (parsed.length > 1 ? parsed[1] : null) : parsed;
        return { engineType, sioType, eventName, payload, ackId };
    }

    function encodeEvent(eventName, payload) {
        const arr = payload === undefined ? [eventName] : [eventName, payload];
        return '42' + JSON.stringify(arr);
    }

    function isEventFrame(raw) {
        return typeof raw === 'string' && raw.startsWith('42');
    }

    // ──────────────────────────────────────────────────────────────────────
    // Binary frame parser/encoder (the May-2026 protocol).
    // ──────────────────────────────────────────────────────────────────────

    /**
     * Decode a binary socket.io packet (msgpack-parser format).
     * Returns the same shape as parseFrame for downstream consumers:
     *   { engineType:4, sioType, eventName, payload, ackId }
     *
     * For sioType === 2 (EVENT), data is expected to be a 2-element array
     * [eventName, payload] — we surface it as { eventName, payload } so
     * the dispatch code stays identical to the old text-frame path.
     *
     * Returns null on undecodable input.
     */
    function parseBinaryFrame(buffer) {
        if (!buffer) return null;
        let decoded;
        try { decoded = mpDecode(buffer); }
        catch (e) {
            try { console.warn('[COR3.wsFrames] msgpack-decode failed', e && e.message); } catch (_) {}
            return null;
        }
        if (!decoded || typeof decoded !== 'object') return null;
        const sioType = (typeof decoded.type === 'number') ? decoded.type : null;
        if (sioType === null) return null;

        // EVENT — data is [eventName, payload?]
        if (sioType === 2 && Array.isArray(decoded.data) && decoded.data.length > 0) {
            return {
                engineType: 4,
                sioType: 2,
                eventName: String(decoded.data[0]),
                payload: decoded.data.length > 1 ? decoded.data[1] : null,
                ackId: typeof decoded.id === 'number' ? decoded.id : null,
                nsp: decoded.nsp || '/',
            };
        }

        // ACK — data is [arg0, arg1, ...]. We don't currently produce or
        // consume acks; pass payload through as-is.
        if (sioType === 3) {
            return {
                engineType: 4,
                sioType: 3,
                eventName: null,
                payload: Array.isArray(decoded.data) ? decoded.data : null,
                ackId: typeof decoded.id === 'number' ? decoded.id : null,
                nsp: decoded.nsp || '/',
            };
        }

        // CONNECT / DISCONNECT / etc. Surface the raw data field so callers
        // can extract sid/pid/etc if they care.
        return {
            engineType: 4,
            sioType,
            eventName: null,
            payload: decoded.data == null ? null : decoded.data,
            ackId: null,
            nsp: decoded.nsp || '/',
        };
    }

    /**
     * Encode an outbound EVENT packet. Returns ArrayBuffer ready for
     * WebSocket.send().
     *
     *   eventName   first array element on the wire. For RPCs use "event";
     *               for room joins use "join-room" / "leave-room".
     *   payload     the second array element (object).
     */
    function encodeEventBinary(eventName, payload) {
        const data = payload === undefined ? [eventName] : [eventName, payload];
        const packet = { type: 2, data, nsp: '/' };
        const bytes = mpEncode(packet);
        // .buffer of a freshly-allocated typed array is safe to ship; no
        // shared offset/length concerns.
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }

    /**
     * Encode an outbound CONNECT packet — used only on first attach with
     * the auth token. Cor3.gg sends this themselves; this helper is here
     * for completeness (and for future reconnect-from-extension flows).
     */
    function encodeConnectBinary(authObj) {
        const packet = { type: 0, data: authObj || {}, nsp: '/' };
        const bytes = mpEncode(packet);
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }

    function isBinaryFrame(raw) {
        return (raw instanceof ArrayBuffer) || ArrayBuffer.isView(raw);
    }

    root.COR3.wsFrames = {
        // Text (legacy + engine.io control)
        parseFrame, encodeEvent, isEventFrame,
        // Binary (current cor3.gg protocol)
        parseBinaryFrame, encodeEventBinary, encodeConnectBinary, isBinaryFrame,
        // Low-level codec — exposed for tests / future modules
        mpEncode, mpDecode,
    };
})();
