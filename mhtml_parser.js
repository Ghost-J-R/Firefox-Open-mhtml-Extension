// mhtml_parser_newtab.js - 改造版：新标签页显示 + 原有功能完整保留

// ---------- Utilities ----------
function decodeQuotedPrintableToBytes(qp) {
    qp = qp.replace(/\r\n/g, '\n').replace(/=\n/g, '');
    const bytes = [];
    for (let i = 0; i < qp.length; i++) {
        const ch = qp[i];
        if (ch === '=' && i + 2 < qp.length && /[A-Fa-f0-9]{2}/.test(qp.substr(i + 1, 2))) {
            bytes.push(parseInt(qp.substr(i + 1, 2), 16));
            i += 2;
        } else {
            bytes.push(qp.charCodeAt(i));
        }
    }
    return new Uint8Array(bytes);
}

function decodeBase64ToBytes(b64) {
    const bin = atob(b64.replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

function decodeBytes(bytes, charset) {
    charset = (charset || 'utf-8').toLowerCase();
    try { return new TextDecoder(charset).decode(bytes); }
    catch (e) { try { return new TextDecoder('utf-8').decode(bytes); } catch(e2) { return new TextDecoder('iso-8859-1').decode(bytes); } }
}

function detectCharsetFromHtml(text, defaultCharset) {
    const metaMatch = text.match(/<meta[^>]+charset=["']?([\w-]+)/i);
    if (metaMatch) return metaMatch[1].toLowerCase();
    const suspicious = (text.match(/[ÃÂæ¼½¾]/g) || []).length;
    if (suspicious > 20) return 'gbk';
    return defaultCharset || 'utf-8';
}

function cleanBase64Text(b64) { return b64.replace(/[^A-Za-z0-9+/=]/g, ''); }

function guessMimeFromData(bytes, fallback) {
    const head = Array.from(bytes.slice(0, 12)).map(b => b.toString(16).padStart(2,'0')).join('');
    if (head.startsWith('ffd8ff')) return 'image/jpeg';
    if (head.startsWith('89504e47')) return 'image/png';
    if (head.startsWith('47494638')) return 'image/gif';
    if (head.startsWith('52494646')) return 'image/webp';
    if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(4,8)) === 'ftyp') {
        const brand = String.fromCharCode(...bytes.slice(8,12));
        if (brand === 'avif' || brand === 'avis') return 'image/avif';
    }
    return fallback || 'application/octet-stream';
}

function bytesToDataURI(bytes, mime) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const b64 = btoa(binary);
    return `data:${mime};base64,${b64}`;
}

function resolveUrl(base, relative) {
    if (!relative) return relative;
    if (/^(data:|https?:|\/\/)/i.test(relative)) return relative;
    try { if (/^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(base)) return new URL(relative, base).toString(); } catch(e){}
    const baseParts = base.split('/'); baseParts.pop();
    const parts = relative.split('/');
    for (const p of parts) { if(p=='.') continue; else if(p=='..') baseParts.pop(); else baseParts.push(p); }
    return baseParts.join('/');
}

function replaceCSSUrls(cssText, resources, baseUrl) {
    return cssText.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi,(m,q,url)=>{
        const abs = resolveUrl(baseUrl||'', url);
        if (resources[abs]) return `url(${resources[abs]})`;
        if (resources[url]) return `url(${resources[url]})`;
        return m;
    });
}

function removeIntegrity(node) { if(node.removeAttribute && node.hasAttribute('integrity')) node.removeAttribute('integrity'); }

// ---------- MHTML Parsing ----------
function parseMHTML(rawText) {
    const result = { resources:{}, htmlParts:[], indexLocation:null };
    const topHeadersMatch = rawText.match(/^[\s\S]*?\r?\n\r?\n/);
    let topHeaders = topHeadersMatch? topHeadersMatch[0]: '';
    const boundaryMatch = topHeaders.match(/boundary="?([^"\r\n;]+)"?/i);
    let boundary = boundaryMatch? boundaryMatch[1]: null;
    if (!boundary) { const autoMatch = rawText.match(/--([^\r\n]{10,})/); boundary = autoMatch ? autoMatch[1] : null; }

    if (!boundary) { const afterHeaders = rawText.split(/\r?\n\r?\n/).slice(1).join('\r\n\r\n'); result.htmlParts.push({ headers:{}, rawBody:afterHeaders }); return result; }

    const parts = rawText.split(new RegExp('--'+boundary+'(?:--)?\\s*'));
    for (const part of parts) {
        if (!part || /^\s*--?$/.test(part)) continue;
        const m = part.match(/([\s\S]*?)\r?\n\r?\n([\s\S]*)/);
        if (!m) continue;
        const headerText = m[1].trim();
        const bodyText = m[2].replace(/\r?\n$/,'');
        const headers = {}; let curKey = null;
        for (let line of headerText.split(/\r?\n/)) {
            if(/^\s/.test(line)&&curKey){ headers[curKey]+=' '+line.trim(); }
            else { const idx=line.indexOf(':'); if(idx>-1){ const key=line.substring(0,idx).trim(); const val=line.substring(idx+1).trim(); headers[key]=val; curKey=key; } }
        }

        const cType = headers['Content-Type']||'';
        const cLoc = headers['Content-Location']||headers['Content-location']||'';
        const cEnc = headers['Content-Transfer-Encoding']||headers['Content-transfer-encoding']||'';
        const cId = headers['Content-ID']||headers['Content-id']||'';

        const ctMatch = cType.match(/([^;]+)(?:;\s*charset=(["']?)([^;"']+)\2)?/i);
        const mime = ctMatch? ctMatch[1].trim().toLowerCase(): 'application/octet-stream';
        const charset = ctMatch&&ctMatch[3]? ctMatch[3].trim().toLowerCase(): null;
        const encoding = cEnc.trim().toLowerCase();

        if (/text\/html/i.test(mime)) { result.htmlParts.push({ headers:{ mime, charset, encoding, location:cLoc, id:cId }, rawBody:bodyText }); if (!result.indexLocation && cLoc) result.indexLocation=cLoc.trim(); continue; }

        let key = cLoc? decodeURIComponent(cLoc.trim()):(cId?cId.trim():`part-${Math.random().toString(36).slice(2,9)}`);
        let dataBytes=null;
        try{
            if(encoding==='base64'){ dataBytes=decodeBase64ToBytes(cleanBase64Text(bodyText)); }
            else if(encoding==='quoted-printable'){ dataBytes=decodeQuotedPrintableToBytes(bodyText); }
            else { const arr=new Uint8Array(bodyText.length); for(let i=0;i<bodyText.length;i++) arr[i]=bodyText.charCodeAt(i)&0xFF; dataBytes=arr; }
        } catch(e){ const arr=new Uint8Array(bodyText.length); for(let i=0;i<bodyText.length;i++) arr[i]=bodyText.charCodeAt(i)&0xFF; dataBytes=arr; }

        result.resources[key] = { mime, encoding, charset, bytes:dataBytes, originalBody:bodyText };
    }
    return result;
}

// ---------- Build final HTML from raw MHTML text ----------
async function buildRenderedHTML(rawText) {
    const parsed = parseMHTML(rawText);
    const resources = {};

    for (const key in parsed.resources) {
        const entry = parsed.resources[key];
        let mime = entry.mime || 'application/octet-stream';
        if (/octet-stream|text\/plain/i.test(mime)) mime = guessMimeFromData(entry.bytes, mime);

        let dataUri = null;
        try {
            if (/^text\//i.test(mime) && entry.bytes) {
                const text = decodeBytes(entry.bytes, entry.charset || 'utf-8');
                dataUri = `data:${mime};charset=utf-8,${encodeURIComponent(text)}`;
            } else if (entry.bytes) { dataUri = bytesToDataURI(entry.bytes, mime); }
            else { dataUri = `data:${mime};charset=utf-8,${encodeURIComponent(entry.originalBody)}`; }
        } catch (e) {
            try { const b64 = btoa(entry.originalBody); dataUri = `data:${mime};base64,${b64}`; }
            catch (e2) { dataUri = `data:${mime};charset=utf-8,${encodeURIComponent(entry.originalBody)}`; }
        }

        resources[key] = dataUri;
        resources[key.replace(/[<>]/g, '')] = dataUri;
        console.log(`[MHTML] 资源替换成功: ${key} => ${mime}`);
    }

    let chosenHtmlPart = null;
    if (parsed.htmlParts.length === 0) {
        throw new Error('[MHTML] 无法识别主 HTML 段');
    }
    if (parsed.indexLocation) {
        const matchPart = parsed.htmlParts.find(p => (p.headers.location || '').includes(parsed.indexLocation));
        if (matchPart) chosenHtmlPart = matchPart;
    }
    if (!chosenHtmlPart) {
        parsed.htmlParts.sort((a, b) => b.rawBody.length - a.rawBody.length);
        chosenHtmlPart = parsed.htmlParts[0];
    }

    let htmlText = '';
    try {
        const enc = (chosenHtmlPart.headers.encoding || '').toLowerCase();
        const cs = chosenHtmlPart.headers.charset || 'utf-8';
        let bytes = null;
        if (enc === 'base64') bytes = decodeBase64ToBytes(cleanBase64Text(chosenHtmlPart.rawBody.replace(/\r?\n/g, '')));
        else if (enc === 'quoted-printable') bytes = decodeQuotedPrintableToBytes(chosenHtmlPart.rawBody);
        else { const arr = new Uint8Array(chosenHtmlPart.rawBody.length); for (let i = 0; i < chosenHtmlPart.rawBody.length; i++) arr[i] = chosenHtmlPart.rawBody.charCodeAt(i) & 0xFF; bytes = arr; }

        htmlText = decodeBytes(bytes, cs).trim();
        const detected = detectCharsetFromHtml(htmlText, cs);
        if (detected && detected !== cs.toLowerCase()) { console.log(`[MHTML] 自动切换 HTML charset: ${cs} => ${detected}`); htmlText = decodeBytes(bytes, detected); }
        else { console.log(`[MHTML] HTML charset 使用: ${cs}`); }
    } catch (e) { htmlText = chosenHtmlPart.rawBody; console.warn('[MHTML] HTML 解析异常, 使用原始文本'); }

    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlText, 'text/html');
    if (!doc.querySelector('meta[charset]')) { const meta = doc.createElement('meta'); meta.setAttribute('charset', 'UTF-8'); if (doc.head) doc.head.insertBefore(meta, doc.head.firstChild); }

    function findResourceFor(ref, baseForResolve) {
        if (!ref) return null;
        if (resources[ref]) return resources[ref];
        try { const dec = decodeURIComponent(ref); if (resources[dec]) return resources[dec]; } catch (e) {}
        if (baseForResolve) { const abs = resolveUrl(baseForResolve, ref); if (resources[abs]) return resources[abs]; }
        const cleaned = ref.replace(/^cid:/i, '').replace(/[<>]/g, ''); if (resources[cleaned]) return resources[cleaned];
        try { const last = ref.split('/').pop(); for (const k in resources) if (k.endsWith(last)) return resources[k]; } catch (e) {}
        console.warn(`[MHTML] 找不到资源: ${ref}`);
        return null;
    }

    function traverseAndReplace(node, baseUrlCandidate) {
        if (!node || node.nodeType !== 1) return;
        removeIntegrity(node);
        const attrList = ['src', 'href', 'data-src', 'data-href'];
        for (const attr of attrList) { if (node.hasAttribute && node.hasAttribute(attr)) { const val = node.getAttribute(attr); if (val) { const dataUri = findResourceFor(val, baseUrlCandidate); if (dataUri) { node.setAttribute(attr, dataUri); console.log(`[MHTML] 节点替换 ${attr}: ${val} => data URI`); } } } }
        if (node.hasAttribute && node.hasAttribute('style')) { const styleVal = node.getAttribute('style') || ''; const replaced = replaceCSSUrls(styleVal, resources, baseUrlCandidate); if (replaced !== styleVal) { node.setAttribute('style', replaced); console.log('[MHTML] style CSS url 替换'); } }
        if (node.tagName === 'STYLE') { const cssText = node.textContent || ''; node.textContent = replaceCSSUrls(cssText, resources, baseUrlCandidate); }
        if (node.tagName === 'LINK') { const rel = (node.getAttribute('rel') || '').toLowerCase(); if (rel === 'stylesheet') { const href = node.getAttribute('href'); if (href) { const dataUri = findResourceFor(href, baseUrlCandidate); if (dataUri) { try { let payload = ''; if (dataUri.startsWith('data:text')) { const idx = dataUri.indexOf(','); payload = decodeURIComponent(dataUri.substring(idx + 1)); if (/^data:[^;]+;base64,/.test(dataUri)) { const base = dataUri.split(',')[1]; const bytes = decodeBase64ToBytes(base); payload = decodeBytes(bytes, 'utf-8'); } const styleEl = doc.createElement('style'); styleEl.type = 'text/css'; styleEl.appendChild(doc.createTextNode(replaceCSSUrls(payload, resources, href))); node.parentNode.replaceChild(styleEl, node); console.log(`[MHTML] LINK CSS 替换: ${href}`); } } catch (e) { console.warn(`[MHTML] LINK CSS 替换异常: ${href}`); } } } } }
        if (node.tagName === 'IMG') { const src = node.getAttribute('src') || node.getAttribute('data-src'); if (src) { const dataUri = findResourceFor(src, baseUrlCandidate); if (dataUri) node.setAttribute('src', dataUri); else console.warn(`[MHTML] 图片替换失败: ${src}`); } }
        if (node.tagName === 'IFRAME') { const src = node.getAttribute('src'); if (src && /^cid:/i.test(src)) { const cid = src.replace(/^cid:/i, '').replace(/[<>]/g, ''); let matched = null; for (const k in resources) if (k.includes(cid) || k.replace(/[<>]/g, '') === cid) { matched = resources[k]; break; } if (matched) node.setAttribute('src', matched); } else if (src) { const dataUri = findResourceFor(src, baseUrlCandidate); if (dataUri) node.setAttribute('src', dataUri); } }
        let childBase = baseUrlCandidate;
        if (node.tagName === 'BASE' && node.getAttribute('href')) childBase = node.getAttribute('href');
        const children = Array.from(node.childNodes || []);
        for (const c of children) if (c.nodeType === 1) traverseAndReplace(c, childBase);
    }

    let baseCandidate = null;
    const baseTag = doc.querySelector('base[href]');
    if (baseTag) baseCandidate = baseTag.getAttribute('href');
    else if (parsed.indexLocation) baseCandidate = parsed.indexLocation;
    traverseAndReplace(doc.documentElement, baseCandidate);

    return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
}

// ---------- Dispatch: fromStorage mode (from popup option 1) vs manual mode (option 2) ----------
(async () => {
    const fromStorage = new URLSearchParams(window.location.search).get('fromStorage') === '1';

    if (fromStorage) {
        try {
            const { mhtmlContent } = await chrome.storage.local.get('mhtmlContent');
            await chrome.storage.local.remove('mhtmlContent');
            if (mhtmlContent) {
                const finalHtml = await buildRenderedHTML(mhtmlContent);
                document.open();
                document.write(finalHtml);
                document.close();
                console.log('[MHTML] 渲染完成(当前标签页)');
                return;
            }
            console.warn('[MHTML] fromStorage=1 但 storage 为空,回退到手动选择');
        } catch (e) {
            console.error('[MHTML] 自动渲染失败,回退到手动选择:', e);
        }
    }

    document.getElementById('loading')?.remove();
    document.getElementById('picker').hidden = false;

    document.getElementById('mhtmlFile').addEventListener('change', async (event) => {
        const file = event.target.files[0];
        if (!file) return;
        console.log('[MHTML] 文件加载:', file.name);
        try {
            const rawText = await file.text();
            const finalHtml = await buildRenderedHTML(rawText);
            const newTab = window.open('', '_blank');
            if (newTab) {
                newTab.document.open();
                newTab.document.write(finalHtml);
                newTab.document.close();
                console.log('[MHTML] 渲染完成，新标签页已显示');
            } else {
                console.warn('[MHTML] 新标签页打开失败，可能被浏览器拦截');
            }
        } catch (e) {
            console.error('[MHTML] 渲染失败:', e);
            alert('[MHTML] 渲染失败: ' + e.message);
        }
    });
})();
