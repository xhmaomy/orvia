import { createHash } from 'node:crypto';
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export function acceptWebSocket(request, socket) {
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string' || key.length === 0) {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        return false;
    }
    const accept = createHash('sha1').update(key + WEBSOCKET_GUID).digest('base64');
    socket.write([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
    ].join('\r\n'));
    return true;
}
export function sendWebSocketText(socket, text) {
    const payload = Buffer.from(text);
    const length = payload.length;
    const header = length < 126
        ? Buffer.from([0x81, length])
        : length < 65536
            ? Buffer.from([0x81, 126, length >> 8, length & 0xff])
            : Buffer.alloc(10);
    if (length >= 65536) {
        header[0] = 0x81;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(length), 2);
    }
    socket.write(Buffer.concat([header, payload]));
}
