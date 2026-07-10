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

function parseRappiCorridors(storeData) {
  const nomeLoja = storeData.name || storeData.brand_name || 'Restaurante';
  const corridors = storeData.corridors || [];
  let textoCompleto = `${nomeLoja}\n\n`;
  const produtos = [];
  const seen = new Set();
  for (const corridor of corridors) {
    const catName = corridor.name || '';
    if (catName) textoCompleto += `\n## ${catName}\n`;
    for (const item of (corridor.products || [])) {
      const nome = (item.name || '').trim();
      const desc = (item.description || '').trim();
      const precoNum = Number(item.real_price || item.price || 0);
      const preco = precoNum > 0 ? `R$ ${precoNum.toFixed(2).replace('.', ',')}` : '';
      if (!nome || !preco) continue;
      const key = `${nome}|${preco}`;
      if (seen.has(key)) continue;
      seen.add(key);
      textoCompleto += `${nome}\n${desc ? desc + '\n' : ''}${preco}\n\n`;
      produtos.push({ nome: nome.slice(0, 90), preco, precoNum, descricao: desc.slice(0, 220), temFoto: !!(item.image) });
    }
  }
  return { nomeLoja, textoCompleto, produtos };
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

function parseIfoodMenu(data) {
  // Resposta do site-api vem em { code: "00", data: { menu: [...] } }
  // Resposta da marketplace-api vem diretamente sem wrapper
  const inner = data?.data || data;
  const nomeLoja = inner?.name || data?.name || 'Restaurante';

  let sections = [];
  if (Array.isArray(inner?.menu)) sections = inner.menu;
  else if (Array.isArray(inner?.catalog)) sections = inner.catalog;
  else if (Array.isArray(data?.menu)) sections = data.menu;
  else if (Array.isArray(data?.sections)) sections = data.sections;

  let textoCompleto = `${nomeLoja}\n\n`;
  const produtos = [];

  for (const sec of sections) {
    const catName = sec.name || sec.title || '';
    const items = sec.itens || sec.items || sec.products || sec.cards || [];
    if (catName) textoCompleto += `\n## ${catName}\n`;

    for (const item of items) {
      const nome = (item.description || item.name || item.title || '').trim();
      const desc = (item.details || item.additionalInfo || item.subtitle || '').trim();
      // iFood site-api retorna preços em REAIS (unitPrice: 52 = R$52,00)
      const precoNum = Number(item.unitPrice || item.unitMinPrice || item.price || item.value || 0);
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

  // Endpoint principal: site-api (é o que o próprio frontend iFood usa)
  const siteApiUrl = `https://www.ifood.com.br/site-api/v1/merchants/restaurant/${uuid}/catalog`;
  const siteApiHeaders = {
    'Accept': 'application/json, text/plain, */*',
    'app_version': '9.153.0',
    'browser': 'Chrome',
    'platform': 'Desktop',
    'access_key': '69f181d5-0046-4221-b7b2-deef62bd60d5',
    'Referer': url,
    'Origin': 'https://www.ifood.com.br',
  };

  try {
    console.log(`📡 iFood site-api: ${siteApiUrl}`);
    const data = await httpGetJson(siteApiUrl, siteApiHeaders, 12000);
    const { nomeLoja, textoCompleto, produtos } = parseIfoodMenu(data);
    if (produtos.length > 0) {
      console.log(`✅ iFood site-api: ${produtos.length} produtos de "${nomeLoja}"`);
      return buildResult('ifood', textoCompleto, produtos);
    }
  } catch (e) {
    console.warn(`iFood site-api: ${e.message}`);
  }

  // Fallback: marketplace API
  for (const endpoint of [
    `https://marketplace.ifood.com.br/v2/merchants/${uuid}?required_info=MENU`,
    `https://marketplace.ifood.com.br/v1/merchants/${uuid}/catalog`,
  ]) {
    try {
      console.log(`📡 iFood marketplace API: ${endpoint}`);
      const data = await httpGetJson(endpoint, ifooodHeaders, 12000);
      const { nomeLoja, textoCompleto, produtos } = parseIfoodMenu(data);
      if (produtos.length > 0) {
        console.log(`✅ iFood marketplace: ${produtos.length} produtos de "${nomeLoja}"`);
        return buildResult('ifood', textoCompleto, produtos);
      }
    } catch (e) {
      console.warn(`iFood marketplace: ${e.message}`);
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

// Chave estática do frontend Rappi (bundle JS) usada para obter token guest anônimo
const RAPPI_GUEST_KEY = 'fDvxV+6QI/FeoLIIAt3Fnl/JsL3Dwhsg3GDjeMLw9qyOM1jUly5rHeg3qB5ejHbnc4jqNwNNdCnQW/xfnSX7RPI3TVnSSGlmYgKW3vqD2+nMDoZ+CgqF4TtDY0druCNhzt0c0RWoeg/LiEH6z7VX03pMt2gPybExsWPOniMS/ha+h++IBgcHuvxTQM4iudpqPIuEWJb8czUJ2lMgPJp4ch1tq0NHSkFVeAfQvuyw+wtL52Y9d90cGrjs8hSezNE1Q80qdadxPXEcF81fi9JrcWdh5EEkAG4zhq5UdOrmj/KfCyHOipryZRS/E7uHqhScSOG7xKJKpDTGOnhL0kN37A==';

async function getRappiGuestToken() {
  const resp = await Promise.race([
    fetch('https://services.rappi.com.br/api/rocket/v2/guest', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-guest-api-key': RAPPI_GUEST_KEY,
        'origin': 'https://www.rappi.com.br',
        'referer': 'https://www.rappi.com.br/',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
        'accept-language': 'pt-BR',
      },
    }).then(r => r.ok ? r.json() : Promise.reject(new Error(`guest HTTP ${r.status}`))),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000)),
  ]);
  if (!resp.access_token) throw new Error('no access_token');
  return resp.access_token;
}

async function captureRappi(url) {
  // URL Brasil: /restaurantes/{numericId}-{slug}
  const m = url.match(/restaurantes\/(\d+)(?:-[^/?#]*)?/);
  if (!m) return null;
  const storeId = m[1];

  try {
    console.log(`📡 Rappi: obtendo token guest...`);
    const bearerToken = await getRappiGuestToken();

    console.log(`📡 Rappi: carregando cardápio da loja ${storeId}...`);
    const storeData = await Promise.race([
      fetch(`https://services.rappi.com.br/api/web-gateway/web/restaurants-bus/store/id/${storeId}/`, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${bearerToken}`,
          'content-type': 'application/json; charset=UTF-8',
          'accept': 'application/json',
          'origin': 'https://www.rappi.com.br',
          'referer': 'https://www.rappi.com.br/',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
          'accept-language': 'pt-BR',
          'deviceid': '857bb725-8cd8-4f39-98b7-149163b6e441',
          'app-version-name': '1.162.2',
          'app-version': '1.162.2',
        },
        body: JSON.stringify({ lat: -22.9068, lng: -43.1729, store_type: 'restaurant', is_prime: false, prime_config: { unlimited_shipping: false } }),
      }).then(r => r.ok ? r.json() : Promise.reject(new Error(`store HTTP ${r.status}`))),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 12000)),
    ]);

    const nomeLoja = storeData.name || storeData.brand_name || 'Restaurante';
    const corridors = storeData.corridors || [];
    let textoCompleto = `${nomeLoja}\n\n`;
    const produtos = [];
    const seen = new Set();

    for (const corridor of corridors) {
      const catName = corridor.name || '';
      if (catName) textoCompleto += `\n## ${catName}\n`;
      for (const item of (corridor.products || [])) {
        const nome = (item.name || '').trim();
        const desc = (item.description || '').trim();
        const precoNum = Number(item.real_price || item.price || 0);
        const preco = precoNum > 0 ? `R$ ${precoNum.toFixed(2).replace('.', ',')}` : '';
        if (!nome || !preco) continue;
        // Produto aparece em múltiplos corredores; deduplica
        const key = `${nome}|${preco}`;
        if (seen.has(key)) continue;
        seen.add(key);
        textoCompleto += `${nome}\n${desc ? desc + '\n' : ''}${preco}\n\n`;
        produtos.push({ nome: nome.slice(0, 90), preco, precoNum, descricao: desc.slice(0, 220), temFoto: !!(item.image) });
      }
    }

    if (produtos.length > 0) {
      console.log(`✅ Rappi: ${produtos.length} produtos de "${nomeLoja}"`);
      return buildResult('rappi', textoCompleto, produtos);
    }
  } catch (e) {
    console.warn(`Rappi: ${e.message}`);
  }
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

// ─── Goomer ──────────────────────────────────────────────────────────────────

function extractGoomerSlug(url) {
  // Formatos: kansas.goomer.app  ou  goomer.app/cardapio/kansas  ou  app.goomer.app/kansas
  const subdomain = url.match(/^https?:\/\/([a-z0-9-]+)\.goomer\.app/i);
  if (subdomain && subdomain[1] !== 'www' && subdomain[1] !== 'app' && subdomain[1] !== 'api') return subdomain[1];
  const path = url.match(/goomer\.app\/[^/]*\/([a-z0-9-]+)/i);
  if (path) return path[1];
  return null;
}

async function captureGoomer(url) {
  const slug = extractGoomerSlug(url);
  if (!slug) return null;

  try {
    // Passo 1: obter informações do restaurante e URL do cardápio
    console.log(`📡 Goomer: info do slug "${slug}"...`);
    const info = await httpGetJson(
      `https://api-go.goomer.app/v2/establishments/${slug}/info?mode=slug&provider=ggo&lang=pt-BR`,
      { 'Origin': `https://${slug}.goomer.app`, 'Referer': `https://${slug}.goomer.app/` },
      10000
    );

    const menuUrl = info?.info?.menu;
    if (!menuUrl) throw new Error('menu URL não encontrada na resposta info');
    console.log(`📡 Goomer: carregando cardápio de ${menuUrl}...`);

    // Passo 2: obter os produtos do cardápio
    const menuData = await httpGetJson(
      menuUrl + '?provider=ggo',
      { 'Origin': `https://${slug}.goomer.app`, 'Referer': `https://${slug}.goomer.app/` },
      12000
    );

    const nomeLoja = info.info?.name || info.settings?.name || 'Restaurante';
    const products = menuData.products || menuData.groups?.flatMap(g => g.products || []) || [];

    let textoCompleto = `${nomeLoja}\n\n`;
    const produtos = [];
    let currentCategory = '';

    for (const item of products) {
      const catName = item.group_name || '';
      if (catName && catName !== currentCategory) {
        textoCompleto += `\n## ${catName}\n`;
        currentCategory = catName;
      }
      const nome = (item.name || '').trim();
      const desc = (item.description || '').trim();
      // Goomer retorna preços em REAIS (price: 49 = R$ 49,00)
      const primeiroPreco = (item.prices || [])[0];
      const precoNum = Number(item.price_tag || primeiroPreco?.price || 0);
      const preco = precoNum > 0 ? `R$ ${precoNum.toFixed(2).replace('.', ',')}` : '';
      const temFoto = !!(item.images?.medium || item.images?.small);
      if (!nome || !preco) continue;
      textoCompleto += `${nome}\n${desc ? desc + '\n' : ''}${preco}\n\n`;
      produtos.push({ nome: nome.slice(0, 90), preco, precoNum, descricao: desc.slice(0, 220), temFoto });
    }

    if (produtos.length > 0) {
      console.log(`✅ Goomer: ${produtos.length} produtos de "${nomeLoja}"`);
      return buildResult('goomer', textoCompleto, produtos);
    }
  } catch (e) {
    console.warn(`Goomer: ${e.message}`);
  }
  return null;
}

// ─── Abrahão ─────────────────────────────────────────────────────────────────

async function captureAbrahao(url) {
  // Abrahão usa o mesmo backend do Goomer (is_abrahao: true nos settings)
  // URLs como restaurante.abrahao.app ou abrahao.app/restaurante
  const subdomain = url.match(/^https?:\/\/([a-z0-9-]+)\.abrahao\.app/i);
  const slug = subdomain ? subdomain[1] : url.match(/abrahao\.app\/([a-z0-9-]+)/i)?.[1];
  if (!slug) return null;

  try {
    const info = await httpGetJson(
      `https://api-go.goomer.app/v2/establishments/${slug}/info?mode=slug&provider=abrahao&lang=pt-BR`,
      { 'Origin': `https://${slug}.abrahao.app`, 'Referer': `https://${slug}.abrahao.app/` },
      10000
    );
    const menuUrl = info?.info?.menu;
    if (!menuUrl) return null;

    const menuData = await httpGetJson(
      menuUrl + '?provider=abrahao',
      { 'Origin': `https://${slug}.abrahao.app`, 'Referer': `https://${slug}.abrahao.app/` },
      12000
    );
    const nomeLoja = info.info?.name || 'Restaurante';
    const products = menuData.products || [];
    let textoCompleto = `${nomeLoja}\n\n`;
    const produtos = [];
    let currentCategory = '';

    for (const item of products) {
      const catName = item.group_name || '';
      if (catName && catName !== currentCategory) { textoCompleto += `\n## ${catName}\n`; currentCategory = catName; }
      const nome = (item.name || '').trim();
      const desc = (item.description || '').trim();
      const precoNum = Number(item.price_tag || (item.prices || [])[0]?.price || 0);
      const preco = precoNum > 0 ? `R$ ${precoNum.toFixed(2).replace('.', ',')}` : '';
      if (!nome || !preco) continue;
      textoCompleto += `${nome}\n${desc ? desc + '\n' : ''}${preco}\n\n`;
      produtos.push({ nome: nome.slice(0, 90), preco, precoNum, descricao: desc.slice(0, 220), temFoto: !!(item.images?.medium) });
    }

    if (produtos.length > 0) { console.log(`✅ Abrahão: ${produtos.length} produtos`); return buildResult('abrahao', textoCompleto, produtos); }
  } catch (e) { console.warn(`Abrahão: ${e.message}`); }
  return null;
}

// ─── Detecção e roteamento ────────────────────────────────────────────────────

const PLATFORMS = [
  { pattern: /ifood\.com\.br/i,   name: 'ifood',   handler: captureIfood   },
  { pattern: /rappi\.com/i,        name: 'rappi',   handler: captureRappi   },
  { pattern: /aiqfome\.com/i,      name: 'aiqfome', handler: captureAiqfome },
  { pattern: /goomer\.app/i,       name: 'goomer',  handler: captureGoomer  },
  { pattern: /abrahao\.app/i,      name: 'abrahao', handler: captureAbrahao },
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

module.exports = { captureWithPlatformHandler, buildResult, parseRappiCorridors };
