// mhtml_builder.js - 把 DOM 采集的数据组装成符合 RFC 2557 的 MHTML 文件

function sanitizeFilename(name) {
    return (name || 'page')
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120) || 'page';
}

function toQuotedPrintable(text) {
    const bytes = new TextEncoder().encode(text);
    let out = '';
    let lineLen = 0;
    const push = (chunk) => {
        if (lineLen + chunk.length > 75) { out += '=\r\n'; lineLen = 0; }
        out += chunk;
        lineLen += chunk.length;
    };
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (b === 0x0A) { out += '\r\n'; lineLen = 0; continue; }
        if (b === 0x0D) continue;
        if (b === 0x20 || b === 0x09) {
            const next = bytes[i + 1];
            if (next === 0x0A || next === 0x0D || i === bytes.length - 1) {
                push('=' + b.toString(16).toUpperCase().padStart(2, '0'));
            } else {
                push(String.fromCharCode(b));
            }
            continue;
        }
        if (b >= 33 && b <= 126 && b !== 0x3D) {
            push(String.fromCharCode(b));
        } else {
            push('=' + b.toString(16).toUpperCase().padStart(2, '0'));
        }
    }
    return out;
}

function chunkBase64(b64) {
    return b64.replace(/(.{76})/g, '$1\r\n').replace(/\r\n$/, '') + '\r\n';
}

function encodeSubject(title) {
    if (/^[\x20-\x7e]*$/.test(title)) return title;
    const b64 = btoa(unescape(encodeURIComponent(title)));
    return `=?utf-8?B?${b64}?=`;
}

function buildMHTML({ url, title, pages, resources }) {
    const boundary = '----MultipartBoundary--' +
        Array.from(crypto.getRandomValues(new Uint8Array(12)))
             .map(b => b.toString(16).padStart(2, '0')).join('') + '----';
    const date = new Date().toUTCString();
    const CRLF = '\r\n';
    let out = '';

    out += 'From: <Saved by Firefox Extension>' + CRLF;
    out += `Snapshot-Content-Location: ${url}` + CRLF;
    out += `Subject: ${encodeSubject(title || '')}` + CRLF;
    out += `Date: ${date}` + CRLF;
    out += 'MIME-Version: 1.0' + CRLF;
    out += `Content-Type: multipart/related;${CRLF}\ttype="text/html";${CRLF}\tboundary="${boundary}"` + CRLF;
    out += CRLF;

    for (const page of pages) {
        out += `--${boundary}` + CRLF;
        out += 'Content-Type: text/html' + CRLF;
        out += `Content-ID: <${page.contentId}>` + CRLF;
        out += 'Content-Transfer-Encoding: quoted-printable' + CRLF;
        out += `Content-Location: ${page.url}` + CRLF;
        out += CRLF;
        out += toQuotedPrintable(page.html) + CRLF;
    }

    for (const { url: resUrl, contentType, base64 } of resources) {
        out += `--${boundary}` + CRLF;
        out += `Content-Type: ${contentType}` + CRLF;
        out += 'Content-Transfer-Encoding: base64' + CRLF;
        out += `Content-Location: ${resUrl}` + CRLF;
        out += CRLF;
        out += chunkBase64(base64) + CRLF;
    }

    out += `--${boundary}--` + CRLF;
    return out;
}
