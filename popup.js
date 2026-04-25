const btnPick = document.getElementById('btnPick');
const btnNewTab = document.getElementById('btnNewTab');
const btnSave = document.getElementById('btnSave');
const fileInput = document.getElementById('mhtmlFile');

btnPick.addEventListener('click', () => {
    fileInput.click();
});

fileInput.addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
        const rawText = await file.text();
        await chrome.storage.local.set({ mhtmlContent: rawText });
    } catch (e) {
        console.error('[MHTML] 读取或写入失败:', e);
        alert('文件太大或读取失败,请改用"打开文件选择页"。');
        return;
    }
    await chrome.tabs.create({ url: chrome.runtime.getURL('render.html?fromStorage=1') });
    window.close();
});

btnNewTab.addEventListener('click', async () => {
    await chrome.storage.local.remove('mhtmlContent');
    await chrome.tabs.create({ url: chrome.runtime.getURL('render.html') });
    window.close();
});

// ---------- Save current page as MHTML ----------

function collectFrameData() {
    const baseUrl = document.baseURI;

    // 1) clone 之前读取 input/select/textarea 的 live 值(cloneNode 不复制属性之外的 JS 状态)
    const formState = new Map();
    let formIdx = 0;
    document.querySelectorAll('input, textarea, select, option').forEach(el => {
        el.setAttribute('data-mhtml-fs-id', formIdx);
        formState.set(formIdx, {
            tag: el.tagName,
            type: el.type,
            value: el.value,
            checked: el.checked,
            selected: el.selected
        });
        formIdx++;
    });

    // 2) clone
    const cloned = document.documentElement.cloneNode(true);

    // 3) 表单状态回灌到 clone 属性
    cloned.querySelectorAll('[data-mhtml-fs-id]').forEach(el => {
        const id = parseInt(el.getAttribute('data-mhtml-fs-id'), 10);
        const s = formState.get(id);
        el.removeAttribute('data-mhtml-fs-id');
        if (!s) return;
        if (s.tag === 'OPTION') {
            if (s.selected) el.setAttribute('selected', ''); else el.removeAttribute('selected');
        } else if (s.type === 'checkbox' || s.type === 'radio') {
            if (s.checked) el.setAttribute('checked', ''); else el.removeAttribute('checked');
        } else if (s.tag === 'TEXTAREA') {
            el.textContent = s.value;
        } else {
            el.setAttribute('value', s.value);
        }
    });
    // 原 DOM 清理临时属性
    document.querySelectorAll('[data-mhtml-fs-id]').forEach(el => el.removeAttribute('data-mhtml-fs-id'));

    // 4) 元素剥离(对齐 Chromium frame_serializer)
    cloned.querySelectorAll('script, noscript').forEach(el => el.remove());
    cloned.querySelectorAll('base').forEach(el => el.remove());
    cloned.querySelectorAll('meta[http-equiv="refresh" i]').forEach(el => el.remove());
    cloned.querySelectorAll('meta[http-equiv="Content-Security-Policy" i]').forEach(el => el.remove());
    cloned.querySelectorAll('link[rel="preload" i], link[rel="prefetch" i], link[rel="dns-prefetch" i], link[rel="preconnect" i]').forEach(el => el.remove());

    // 4b) 删除隐藏的大型内联 SVG sprite(对齐 Chromium)
    //     Discord/Bilibili 等页面有隐藏的 SVG 图标库(display:none),Edge 原生保存时会跳过
    //     只删除不可见的 SVG,保留页面布局和可见图标
    cloned.querySelectorAll('svg').forEach(el => {
        const svgSize = el.outerHTML.length;
        const style = el.getAttribute('style') || '';
        const isHidden = style.includes('display:none') || style.includes('display: none') ||
                        el.hasAttribute('hidden') || el.style.display === 'none';

        // 只删除: (隐藏 且 超过 10KB) 或 (包含大量 data URI)
        if ((isHidden && svgSize > 10240) || (el.outerHTML.match(/data:/g) || []).length > 10) {
            el.remove();
        }
    });

    // 4c) 删除视频和音频标签(对齐 Edge - 它们不保存多媒体文件以减小体积)
    //     保留 poster 属性指向的封面图,但删除 video/audio 标签本身
    cloned.querySelectorAll('video, audio').forEach(el => el.remove());

    // 5) 属性剥离:integrity、on*
    cloned.querySelectorAll('[integrity]').forEach(el => el.removeAttribute('integrity'));
    cloned.querySelectorAll('*').forEach(el => {
        [...el.attributes].forEach(a => {
            if (/^on[a-z]+$/i.test(a.name)) el.removeAttribute(a.name);
        });
    });

    // 5b) 把所有 URL 属性绝对化(对齐 Chromium frame_serializer)
    //     修复 Edge/Chrome 打开 MHTML 时,protocol-relative (//host/...) 和相对路径被当成 file:// 解析的问题
    //     保存 MHTML 后 HTML 里的 src/href 变成绝对 URL,和 Content-Location 严格相等,任何浏览器都能匹配
    const absRes = (v) => { try { return new URL(v, baseUrl).href.split('#')[0]; } catch { return v; } };
    const absNav = (v) => { try { return new URL(v, baseUrl).href; } catch { return v; } };
    const rewriteSrcset = (v) => v.split(',').map(entry => {
        const t = entry.trim();
        if (!t) return t;
        const parts = t.split(/\s+/);
        const first = parts.shift();
        return [absRes(first), ...parts].join(' ');
    }).join(', ');
    const rewriteCssUrls = (text) => text
        .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) => `url(${q}${absRes(u)}${q})`)
        .replace(/@import\s+(['"])([^'"]+)\1/g, (m, q, u) => `@import ${q}${absRes(u)}${q}`);

    cloned.querySelectorAll('img[src]').forEach(el => el.setAttribute('src', absRes(el.getAttribute('src'))));
    cloned.querySelectorAll('link[href]').forEach(el => el.setAttribute('href', absRes(el.getAttribute('href'))));
    cloned.querySelectorAll('source[src], video[src], audio[src], embed[src], input[src], track[src]').forEach(el => el.setAttribute('src', absRes(el.getAttribute('src'))));
    cloned.querySelectorAll('video[poster]').forEach(el => el.setAttribute('poster', absRes(el.getAttribute('poster'))));
    cloned.querySelectorAll('object[data]').forEach(el => el.setAttribute('data', absRes(el.getAttribute('data'))));
    cloned.querySelectorAll('iframe[src]').forEach(el => {
        const v = el.getAttribute('src');
        if (v && !/^cid:/i.test(v)) el.setAttribute('src', absRes(v));
    });
    cloned.querySelectorAll('form[action]').forEach(el => el.setAttribute('action', absNav(el.getAttribute('action'))));
    cloned.querySelectorAll('input[formaction]').forEach(el => el.setAttribute('formaction', absNav(el.getAttribute('formaction'))));
    cloned.querySelectorAll('a[href], area[href]').forEach(el => {
        const v = el.getAttribute('href');
        if (v && !/^(#|javascript:|mailto:|tel:|cid:|data:)/i.test(v)) el.setAttribute('href', absNav(v));
    });
    cloned.querySelectorAll('image, use').forEach(el => {
        const h = el.getAttribute('href');
        if (h && !h.startsWith('#')) el.setAttribute('href', absRes(h));
        const xh = el.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
        if (xh && !xh.startsWith('#')) el.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', absRes(xh));
    });
    cloned.querySelectorAll('[srcset]').forEach(el => el.setAttribute('srcset', rewriteSrcset(el.getAttribute('srcset'))));
    cloned.querySelectorAll('[style]').forEach(el => {
        const v = el.getAttribute('style');
        if (v) el.setAttribute('style', rewriteCssUrls(v));
    });
    cloned.querySelectorAll('style').forEach(st => {
        const t = st.textContent;
        if (t) st.textContent = rewriteCssUrls(t);
    });

    // 6) 补 <meta charset="UTF-8">
    const head = cloned.querySelector('head');
    if (head && !cloned.querySelector('meta[charset]')) {
        const meta = document.createElement('meta');
        meta.setAttribute('charset', 'UTF-8');
        head.prepend(meta);
    }

    // 7) Generator 标识
    if (head) {
        const gen = document.createElement('meta');
        gen.setAttribute('name', 'Generator');
        gen.setAttribute('content', 'Mozilla Firefox (MHTML Full Opener extension)');
        head.appendChild(gen);
    }

    // 8) 保留原 DOCTYPE
    const dt = document.doctype;
    const doctype = dt
        ? `<!DOCTYPE ${dt.name}${dt.publicId ? ` PUBLIC "${dt.publicId}"` : ''}${dt.systemId ? ` "${dt.systemId}"` : ''}>\n`
        : '';

    // 9) 收集资源 URL
    const urls = new Set();
    const absolutize = (u) => {
        if (!u) return null;
        try { return new URL(u, baseUrl).href.split('#')[0]; } catch { return null; }
    };
    const add = (u) => { if (u && /^https?:/i.test(u)) urls.add(u); };

    // 9a) 浏览器实际加载过的资源 URL 白名单(对齐 Chromium "从缓存读"的语义)
    //     过滤掉 script/xhr/fetch/beacon/iframe —— 这些我们不需要或已单独处理
    const loadedUrls = new Set();
    try {
        const skipInit = new Set(['script', 'xmlhttprequest', 'fetch', 'beacon', 'iframe']);
        performance.getEntriesByType('resource').forEach(e => {
            if (!e.name || skipInit.has(e.initiatorType)) return;
            try {
                const clean = new URL(e.name).href.split('#')[0];
                if (/^https?:/i.test(clean)) loadedUrls.add(clean);
            } catch {}
        });
    } catch {}

    // 9b) 额外白名单:已经渲染成功的 <img> 的 currentSrc
    //     performance API 对懒加载库(lazysizes、Discourse 之类)的动态 src 有时记录滞后,
    //     用 img.complete && img.naturalWidth > 0 精准捕获"浏览器确实加载完并显示了"的图片
    document.querySelectorAll('img').forEach(el => {
        if (!el.complete || el.naturalWidth === 0) return;
        const s = el.currentSrc || el.getAttribute('src');
        if (!s) return;
        try {
            const abs = new URL(s, baseUrl).href.split('#')[0];
            if (/^https?:/i.test(abs)) loadedUrls.add(abs);
        } catch {}
    });

    // <img>:用 currentSrc(浏览器在 srcset/picture 中实际选中的那一个),不解析 srcset 全集
    // 必须从原始 DOM 读取 currentSrc(cloned DOM 未渲染,没有 currentSrc)
    document.querySelectorAll('img').forEach(el => {
        const s = el.currentSrc || el.getAttribute('src');
        if (s) add(absolutize(s));
    });
    cloned.querySelectorAll('link[rel~="stylesheet"][href], link[rel="icon"][href], link[rel="shortcut icon"][href]').forEach(el => add(absolutize(el.getAttribute('href'))));
    // <source> 在 <video>/<audio> 里是 src 属性;<picture> 里的 source 已通过父 <img>.currentSrc 处理
    // 从 cloned DOM 收集,这样删除的 video/audio 标签不会被抓取
    cloned.querySelectorAll('source[src]').forEach(el => add(absolutize(el.getAttribute('src'))));
    cloned.querySelectorAll('video[poster]').forEach(el => add(absolutize(el.getAttribute('poster'))));
    cloned.querySelectorAll('audio[src]').forEach(el => add(absolutize(el.getAttribute('src'))));
    cloned.querySelectorAll('embed[src]').forEach(el => add(absolutize(el.getAttribute('src'))));
    cloned.querySelectorAll('object[data]').forEach(el => add(absolutize(el.getAttribute('data'))));
    cloned.querySelectorAll('input[type="image"][src]').forEach(el => add(absolutize(el.getAttribute('src'))));
    cloned.querySelectorAll('track[src]').forEach(el => add(absolutize(el.getAttribute('src'))));
    cloned.querySelectorAll('image').forEach(el => {
        add(absolutize(el.getAttribute('href')));
        add(absolutize(el.getAttributeNS('http://www.w3.org/1999/xlink', 'href')));
    });
    cloned.querySelectorAll('use').forEach(el => {
        const href = el.getAttribute('href') || el.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
        if (href && !href.startsWith('#')) add(absolutize(href));
    });

    // 内联 <style> 和 style= 里的 url()
    const urlRe = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g;
    cloned.querySelectorAll('style').forEach(st => {
        let m; urlRe.lastIndex = 0;
        while ((m = urlRe.exec(st.textContent || '')) !== null) add(absolutize(m[1]));
    });
    cloned.querySelectorAll('[style]').forEach(el => {
        let m; const s = el.getAttribute('style') || ''; urlRe.lastIndex = 0;
        while ((m = urlRe.exec(s)) !== null) add(absolutize(m[1]));
    });

    return {
        url: location.href.split('#')[0],
        title: document.title,
        doctype,
        html: cloned.outerHTML,
        urls: [...urls],
        loadedUrls: [...loadedUrls]
    };
}

btnSave.addEventListener('click', async () => {
    const params = new URLSearchParams(location.search);
    const tabIdRaw = params.get('tabId');
    const tabId = tabIdRaw ? parseInt(tabIdRaw, 10) : NaN;
    let tab = null;
    try {
        if (Number.isFinite(tabId)) tab = await chrome.tabs.get(tabId);
    } catch (e) {
        console.warn('[MHTML Save] 读取 tab 失败:', e.message);
    }
    if (!tab || !/^https?:/i.test(tab.url || '')) {
        alert('只能保存 http/https 页面');
        return;
    }
    btnSave.disabled = true;
    btnSave.textContent = '读取页面…';
    try {
        // Step 1: 所有 frame 收集 HTML + URL 列表
        const frameResults = await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            func: collectFrameData
        });
        const mainFrame = frameResults.find(r => r.frameId === 0);
        if (!mainFrame?.result) throw new Error('主文档数据为空');
        const subFrames = frameResults.filter(r => r.frameId !== 0 && r.result);

        // Step 2: 重写主文档 <iframe src> 为 cid:
        const frameByUrl = new Map(subFrames.map(r => [r.result.url, r]));
        const parser = new DOMParser();
        const mainDoc = parser.parseFromString(mainFrame.result.html, 'text/html');
        mainDoc.querySelectorAll('iframe[src]').forEach(iframe => {
            try {
                const absSrc = new URL(iframe.getAttribute('src'), mainFrame.result.url).href.split('#')[0];
                const matched = frameByUrl.get(absSrc);
                if (matched) iframe.setAttribute('src', `cid:frame-${matched.frameId}@mhtml.firefox`);
            } catch {}
        });
        const mainHtml = (mainFrame.result.doctype || '') + mainDoc.documentElement.outerHTML;

        // Step 3: 合并所有 URL + fetch(含 CSS 递归)
        const allUrls = new Set();
        const allLoadedUrls = new Set();
        for (const r of frameResults) {
            if (!r.result) continue;
            r.result.urls.forEach(u => allUrls.add(u));
            (r.result.loadedUrls || []).forEach(u => allLoadedUrls.add(u));
        }
        const useLoadedWhitelist = allLoadedUrls.size > 0;

        // 归一化白名单:去掉 query 的 origin+pathname,用来兜住缓存破坏参数 / CDN 签名 token 场景
        // 例如 DOM 里 `foo.jpg?v=1` vs loaded 里 `foo.jpg?v=2` —— 内容同一个文件,按 pathname 匹配
        const loadedPaths = new Set();
        for (const u of allLoadedUrls) {
            try {
                const x = new URL(u);
                loadedPaths.add(x.origin + x.pathname);
            } catch {}
        }
        const inWhitelist = (url) => {
            if (allLoadedUrls.has(url)) return true;
            try {
                const x = new URL(url);
                return loadedPaths.has(x.origin + x.pathname);
            } catch {
                return false;
            }
        };

        // 用白名单过滤 DOM 收集的 URL:只保留浏览器实际加载过的
        let domFiltered = 0;
        let looseMatched = 0;
        const initialUrls = [];
        for (const u of allUrls) {
            if (!useLoadedWhitelist) { initialUrls.push(u); continue; }
            if (allLoadedUrls.has(u)) {
                initialUrls.push(u);
            } else if (inWhitelist(u)) {
                initialUrls.push(u);
                looseMatched++;
            } else {
                domFiltered++;
            }
        }

        const resources = new Map();
        const failedUrls = [];
        let cssSkipped = 0;
        const pendingUrls = [...initialUrls];
        const seenUrls = new Set(pendingUrls);
        const cssUrlRe = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g;
        const importRe = /@import\s+(?:url\()?\s*['"]?([^'")]+)['"]?\s*\)?\s*(?:[^;]*);?/g;

        let blobUrl = null; // 用于异常时清理

        // 字体分片计数器(对齐 Edge - 限制同一字体家族的分片数量)
        // 例如: FontName.a.woff2, FontName.b.woff2 ... FontName.z.woff2
        const fontFamilyCount = new Map();

        const fetchOne = async (url) => {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 15000);
            try {
                // cache: 'default' 优先使用缓存,节省流量
                // 缓存未命中/过期时自动降级到网络请求
                const res = await fetch(url, {
                    credentials: 'include',
                    cache: 'default',
                    signal: ctrl.signal
                });
                if (!res.ok) {
                    failedUrls.push({ url, reason: `HTTP ${res.status}` });
                    return null;
                }
                const blob = await res.blob();
                if (blob.size === 0) {
                    failedUrls.push({ url, reason: 'empty body' });
                    return null;
                }
                const buf = await blob.arrayBuffer();
                const bytes = new Uint8Array(buf);
                let bin = '';
                for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
                const base64 = btoa(bin);
                const contentType = blob.type || 'application/octet-stream';

                if (/^text\/css/i.test(contentType)) {
                    const cssText = new TextDecoder('utf-8').decode(bytes);
                    const extract = (re) => {
                        re.lastIndex = 0;
                        let m;
                        while ((m = re.exec(cssText)) !== null) {
                            try {
                                const abs = new URL(m[1], url).href.split('#')[0];
                                if (!/^https?:/i.test(abs) || seenUrls.has(abs)) continue;
                                // 只抓浏览器实际加载过的(对齐 Chromium "从缓存读"的语义)
                                // —— 过滤掉 CSS 里声明但未使用的字体字重/分辨率等
                                if (useLoadedWhitelist && !inWhitelist(abs)) {
                                    cssSkipped++;
                                    continue;
                                }

                                // 检测字体分片模式并限制数量(对齐 Edge)
                                // 模式: FontName.a.woff2, FontName.b.woff2 ... (unicode-range 分片)
                                // Edge 不会保存 100+ 个分片,而是依赖系统字体
                                if (/\.woff2?$/i.test(abs)) {
                                    const match = abs.match(/([^\/]+)\.[a-z0-9]{1,2}\.woff2?$/i);
                                    if (match) {
                                        const family = match[1]; // 提取字体家族名
                                        const count = fontFamilyCount.get(family) || 0;
                                        if (count >= 5) { // 每个字体家族最多保留 5 个分片
                                            cssSkipped++;
                                            continue;
                                        }
                                        fontFamilyCount.set(family, count + 1);
                                    }
                                }
                                seenUrls.add(abs);
                                pendingUrls.push(abs);
                            } catch {}
                        }
                    };
                    extract(cssUrlRe);
                    extract(importRe);
                }
                return { contentType, base64 };
            } catch (e) {
                failedUrls.push({ url, reason: e.message });
                console.warn('[MHTML Save] 资源失败:', url, e.message);
                return null;
            } finally {
                clearTimeout(timer);
            }
        };

        let done = 0;
        btnSave.textContent = `抓取资源 (0/${pendingUrls.length})…`;
        while (pendingUrls.length > 0) {
            const batch = pendingUrls.splice(0);
            await Promise.all(batch.map(async (url) => {
                const data = await fetchOne(url);
                if (data) resources.set(url.split('#')[0], data);
                done++;
                btnSave.textContent = `抓取资源 (${done}/${done + pendingUrls.length})…`;
            }));
        }

        console.log(`[MHTML Save] 抓取统计:成功 ${resources.size} / 总共 ${done}(失败 ${failedUrls.length},DOM 白名单过滤 ${domFiltered},宽松匹配救回 ${looseMatched},CSS 白名单过滤 ${cssSkipped})`);
        if (failedUrls.length > 0) {
            console.log('[MHTML Save] 失败清单:', failedUrls);
        }

        // 资源体积统计（按 MIME 类型分组）
        const stats = new Map();
        let totalBytes = 0;

        // 统计 HTML 页面
        const htmlBytes = new TextEncoder().encode(mainHtml).length;
        totalBytes += htmlBytes;
        stats.set('text/html', { count: 1, bytes: htmlBytes, urls: [{ url: 'main.html', size: htmlBytes }] });

        // 分析主 HTML 内容组成（如果超过 1MB）
        if (htmlBytes > 1024 * 1024) {
            const inlineDataUri = (mainHtml.match(/data:[^"')]+/g) || []).reduce((sum, uri) => sum + uri.length, 0);
            const inlineSvg = (mainHtml.match(/<svg[\s\S]*?<\/svg>/gi) || []).reduce((sum, svg) => sum + svg.length, 0);
            const inlineStyle = (mainHtml.match(/<style[\s\S]*?<\/style>/gi) || []).reduce((sum, s) => sum + s.length, 0);
            const inlineScript = (mainHtml.match(/<script[\s\S]*?<\/script>/gi) || []).reduce((sum, s) => sum + s.length, 0);
            const other = htmlBytes - inlineDataUri - inlineSvg - inlineStyle - inlineScript;
            console.log(`[MHTML Save] 主 HTML 内容分析（${(htmlBytes / 1024 / 1024).toFixed(2)} MB）:`);
            console.log(`  - data URI: ${(inlineDataUri / 1024 / 1024).toFixed(2)} MB`);
            console.log(`  - 内联 SVG: ${(inlineSvg / 1024 / 1024).toFixed(2)} MB`);
            console.log(`  - <style>: ${(inlineStyle / 1024 / 1024).toFixed(2)} MB`);
            console.log(`  - <script>: ${(inlineScript / 1024 / 1024).toFixed(2)} MB`);
            console.log(`  - 其他: ${(other / 1024 / 1024).toFixed(2)} MB`);
        }

        for (const sf of subFrames) {
            const frameHtml = (sf.result.doctype || '') + sf.result.html;
            const frameBytes = new TextEncoder().encode(frameHtml).length;
            totalBytes += frameBytes;
            const entry = stats.get('text/html');
            entry.count++;
            entry.bytes += frameBytes;
            entry.urls.push({ url: `frame-${sf.frameId}.html`, size: frameBytes });
        }

        // 统计资源
        for (const [url, data] of resources.entries()) {
            const size = Math.round(data.base64.length * 0.75); // base64 → 原始字节数
            totalBytes += size;
            const mime = data.contentType.split(';')[0].trim();
            if (!stats.has(mime)) stats.set(mime, { count: 0, bytes: 0, urls: [] });
            const entry = stats.get(mime);
            entry.count++;
            entry.bytes += size;
            entry.urls.push({ url: url.split('/').pop(), size });
        }

        console.log(`[MHTML Save] 资源体积统计（总计 ${(totalBytes / 1024 / 1024).toFixed(2)} MB）:`);
        const sorted = [...stats.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
        for (const [mime, data] of sorted) {
            console.log(`  ${mime}: ${data.count} 个, ${(data.bytes / 1024 / 1024).toFixed(2)} MB`);
            // 显示该类型最大的 3 个文件
            const top3 = data.urls.sort((a, b) => b.size - a.size).slice(0, 3);
            for (const item of top3) {
                console.log(`    - ${item.url} (${(item.size / 1024).toFixed(1)} KB)`);
            }
        }

        // Step 4: 组装 pages
        const pages = [
            { url: mainFrame.result.url, html: mainHtml, contentId: 'frame-0@mhtml.firefox' },
            ...subFrames.map(r => ({
                url: r.result.url,
                html: (r.result.doctype || '') + r.result.html,
                contentId: `frame-${r.frameId}@mhtml.firefox`
            }))
        ];

        btnSave.textContent = '生成 MHTML…';
        const mhtmlText = buildMHTML({
            url: mainFrame.result.url,
            title: mainFrame.result.title || '',
            pages,
            resources: [...resources.entries()].map(([url, v]) => ({ url, ...v }))
        });
        const blob = new Blob([mhtmlText], { type: 'multipart/related' });
        blobUrl = URL.createObjectURL(blob);

        const filename = sanitizeFilename(mainFrame.result.title || 'page') + '.mhtml';
        const downloadId = await chrome.downloads.download({ url: blobUrl, filename, saveAs: true });

        // 监听下载完成/取消,释放 Blob URL 避免内存泄漏
        const cleanup = () => {
            URL.revokeObjectURL(blobUrl);
            chrome.downloads.onChanged.removeListener(listener);
        };
        const listener = (delta) => {
            if (delta.id === downloadId && delta.state) {
                if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
                    cleanup();
                }
            }
        };
        chrome.downloads.onChanged.addListener(listener);

        // 5 秒后强制清理(防止监听器失效)
        setTimeout(cleanup, 5000);

        window.close();
    } catch (e) {
        console.error('[MHTML Save] 失败:', e);
        alert('保存失败:' + e.message);
        btnSave.disabled = false;
        btnSave.textContent = '保存当前页为 MHTML';
        // 清理可能已创建的 Blob URL
        if (blobUrl) URL.revokeObjectURL(blobUrl);
    }
});
