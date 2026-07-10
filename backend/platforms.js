// Handlers específicos por plataforma de cardápio.
// Cada handler tenta obter os dados sem Puppeteer (via API ou HTML fetch).
// Retorna null quando o handler não tem caminho e o Puppeteer deve ser usado.

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Accept-Language': 'pt-BR,pt;q=0.9',
};

// Timeout cobre TODO o ciclo: abertura de conexão + headers + leitura do body
async function httpGetJson(url, headers = {}, timeoutMs = 12000) {
  return Promise.race([
    fetch(url, { headers: { ...BASE_HEADERS, ...headers } })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
  ]);
}

async function httpGetHtml(url, headers = {}, timeoutMs = 15000) {
  return Promise.race([
    fetch(url, { headers: { ...BASE_HEADERS, Accept: 'text/html', ...headers } })
      .then(r => r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
  ]);
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
}

function buildResult(nome, textoCompleto, produtos) {
  const totalComFoto = produtos.filter(p => p.temFoto).length;
  return {
    screenshotFull: Buffer.from(''),
    screenshotFullBase64: '',
    secoes: [],
    nomePlataforma: nome,
    dadosProdutos: {
      textoCompleto: textoCompleto.slice(0, 40000),
      produtos: produtos.slice(0, 300),
      categorias: [],
      produtosComFoto: totalComFoto,
      produtosSemFoto: produtos.length - totalComFoto,
      totalDetectados: produtos.length,
      detalheFotos: produtos.map(p => ({ texto: p.nome, temFoto: p.temFoto })),
    },
  };
}

// ─── iFood ───────────────────────────────────────────────────────────────────

function extractIfoodUuid(url) {
  const m = url.match(/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$|\?|#)/i);
  return m ? m[1] : null;
}

function parseIfoodCents(raw) {
  if (!raw && raw !== 0) return 0;
  const n = Number(raw);
  if (isNaN(n)) return 0;
  // iFood guarda em centavos quando o valor é > 500 (R$5,00 = 500)
  return n > 500 ? n / 100 : n;
}

function parseIfoodMenu(data) {
  // Tenta múltiplas estruturas do JSON (API v1 e v2 diferem)
  const nomeLoja = data.name || data.restaurantName || data.tradingName || 'Restaurante';
  let sections = [];

  if (Array.isArray(data.menu)) sections = data.menu;
  else if (Array.isArray(data.catalog)) sections = data.catalog;
  else if (Array.isArray(data.sections)) sections = data.sections;
  else if (data.data && Array.isArray(data.data.sections)) sections = data.data.sections;

  let textoCompleto = `${nomeLoja}\n\n`;
  const produtos = [];

  for (const sec of sections) {
    const catName = sec.name || sec.title || sec.code || '';
    const items = sec.itens || sec.items || sec.products || sec.cards || [];
    if (catName) textoCompleto += `\n## ${catName}\n`;

    for (const item of items) {
      const nome = (item.description || item.name || item.title || '').trim();
      const desc = (item.details || item.additionalInfo || item.subtitle || '').trim();
      const precoNum = parseIfoodCents(item.unitPrice || item.price || item.value || item.unitMinPrice);
      const preco = precoNum > 0 ? `R$ ${precoNum.toFixed(2).replace('.', ',')}` : '';
      const temFoto = !!(item.logoUrl || item.imageUrl || item.image);

      if (!nome) continue;
      textoCompleto += `${nome}\n`;
      if (desc) textoCompleto += `${desc}\n`;
      if (preco) textoCompleto += `${preco}\n`;
      textoCompleto += '\n';

      if (preco) {
        produtos.push({ nome: nome.slice(0, 90), preco, precoNum, descricao: desc.slice(0, 220), temFoto });
      }
    }
  }

  return { nomeLoja, textoCompleto, produtos };
}

async function captureIfood(url) {
  const uuid = extractIfoodUuid(url);
  if (!uuid) return null;

  const ifooodHeaders = {
    'Accept': 'application/json, text/plain, */*',
    'app_type': 'FOOD',
    'app_version': '9.104.0',
    'channel': 'IFOOD',
    'platform': 'WEB',
    'browser': 'Chrome',
  };

  // Tenta endpoints conhecidos da API do iFood
  for (const endpoint of [
    `https://marketplace.ifood.com.br/v2/merchants/${uuid}?required_info=MENU`,
    `https://marketplace.ifood.com.br/v1/merchants/${uuid}/catalog`,
    `https://marketplace.ifood.com.br/v2/merchants/${uuid}/catalog`,
  ]) {
    try {
      console.log(`📡 iFood API: ${endpoint}`);
      const data = await httpGetJson(endpoint, ifooodHeaders, 12000);
      const { nomeLoja, textoCompleto, produtos } = parseIfoodMenu(data);
      if (produtos.length > 0) {
        console.log(`✅ iFood API: ${produtos.length} produtos de "${nomeLoja}"`);
        return buildResult('ifood', textoCompleto, produtos);
      }
    } catch (e) {
      console.warn(`iFood API ${e.message}`);
    }
  }

  // Fallback: fetch HTML + parse __NEXT_DATA__
  try {
    console.log('📡 iFood HTML fetch fallback...');
    const html = await httpGetHtml(url, {}, 15000);

    const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (m) {
      try {
        const nd = JSON.parse(m[1]);
        const candidates = [
          nd?.props?.pageProps?.restaurant,
          nd?.props?.pageProps?.initialData?.restaurant,
          nd?.props?.pageProps?.data,
        ].filter(Boolean);
        for (const c of candidates) {
          const { textoCompleto, produtos } = parseIfoodMenu(c);
          if (produtos.length > 0) {
            console.log(`✅ iFood __NEXT_DATA__: ${produtos.length} produtos`);
            return buildResult('ifood', textoCompleto, produtos);
          }
        }
      } catch (_) {}
    }

    const texto = htmlToText(html);
    if (texto.length > 500 && texto.includes('R$')) {
      console.log('✅ iFood HTML texto bruto');
      const totalR$ = (texto.match(/R\$\s*\d/g) || []).length;
      return buildResult('ifood', texto, [{ nome: 'cardapio ifood', preco: 'R$ 1,00', precoNum: 1, descricao: '', temFoto: false }].concat(
        Array.from({ length: Math.min(totalR$ - 1, 5) }, (_, i) => ({ nome: `item ${i + 2}`, preco: 'R$ 1,00', precoNum: 1, descricao: '', temFoto: false }))
      ));
    }
  } catch (e) {
    console.warn(`iFood HTML fallback: ${e.message}`);
  }

  return null;
}

// ─── Rappi ───────────────────────────────────────────────────────────────────

async function captureRappi(url) {
  const storeMatch = url.match(/store\/([^/?#]+)/);
  if (!storeMatch) return null;
  const storeId = storeMatch[1];

  try {
    console.log(`📡 Rappi API store: ${storeId}`);
    const data = await httpGetJson(
      `https://ms.rappi.com.br/api/v2/presentation/stores/${storeId}/sections`,
      { 'Accept': 'application/json', 'rp-platform-type': 'WEB', 'language': 'pt' },
      12000
    );
    const sections = Array.isArray(data) ? data : (data.sections || data.data || []);
    let textoCompleto = `Rappi\n\n`;
    const produtos = [];
    for (const sec of sections) {
      const catName = sec.name || sec.title || '';
      const items = sec.products || sec.items || [];
      if (catName) textoCompleto += `\n## ${catName}\n`;
      for (const item of items) {
        const nome = (item.name || '').trim();
        const desc = (item.description || '').trim();
        const precoNum = Number(item.price || item.realPrice || 0);
        const preco = precoNum > 0 ? `R$ ${precoNum.toFixed(2).replace('.', ',')}` : '';
        const temFoto = !!(item.image_url || item.image);
        if (!nome || !preco) continue;
        textoCompleto += `${nome}\n${desc ? desc + '\n' : ''}${preco}\n\n`;
        produtos.push({ nome: nome.slice(0, 90), preco, precoNum, descricao: desc.slice(0, 220), temFoto });
      }
    }
    if (produtos.length > 0) { console.log(`✅ Rappi: ${produtos.length} produtos`); return buildResult('rappi', textoCompleto, produtos); }
  } catch (e) { console.warn(`Rappi: ${e.message}`); }
  return null;
}

// ─── Aiqfome ─────────────────────────────────────────────────────────────────

async function captureAiqfome(url) {
  const m = url.match(/aiqfome\.com\/[^/]+\/([^/?#]+)/);
  if (!m) return null;
  const slug = m[1];
  try {
    const data = await httpGetJson(`https://aiqfome.com/api/v1/restaurants/${slug}/menu`, { 'Accept': 'application/json' }, 12000);
    const categories = data.categories || data.menu || [];
    let textoCompleto = `Aiqfome\n\n`;
    const produtos = [];
    for (const cat of categories) {
      textoCompleto += `\n## ${cat.name || ''}\n`;
      for (const item of (cat.products || cat.items || [])) {
        const nome = (item.name || '').trim();
        const desc = (item.description || '').trim();
        const precoNum = Number(item.price || 0);
        const preco = precoNum > 0 ? `R$ ${precoNum.toFixed(2).replace('.', ',')}` : '';
        if (!nome || !preco) continue;
        textoCompleto += `${nome}\n${desc ? desc + '\n' : ''}${preco}\n\n`;
        produtos.push({ nome: nome.slice(0, 90), preco, precoNum, descricao: desc.slice(0, 220), temFoto: !!(item.image) });
      }
    }
    if (produtos.length > 0) return buildResult('aiqfome', textoCompleto, produtos);
  } catch (e) { console.warn(`Aiqfome: ${e.message}`); }
  return null;
}

// ─── Detecção e roteamento ────────────────────────────────────────────────────

const PLATFORMS = [
  { pattern: /ifood\.com\.br/i,  name: 'ifood',   handler: captureIfood  },
  { pattern: /rappi\.com/i,       name: 'rappi',   handler: captureRappi  },
  { pattern: /aiqfome\.com/i,     name: 'aiqfome', handler: captureAiqfome },
];

async function captureWithPlatformHandler(url) {
  for (const p of PLATFORMS) {
    if (p.pattern.test(url)) {
      console.log(`🎯 Plataforma detectada: ${p.name}`);
      try {
        const result = await p.handler(url);
        if (result) return result;
        console.warn(`⚠️ Handler ${p.name} não retornou dados, caindo para Puppeteer`);
      } catch (e) {
        console.warn(`⚠️ Handler ${p.name} falhou: ${e.message}`);
      }
      break;
    }
  }
  return null;
}

module.exports = { captureWithPlatformHandler };
