const FIELD_SEGMENTO    = 3022768
const FIELD_FATURAMENTO = 3022770

const FIELD_UTM_ORIGEM   = 3048714
const FIELD_UTM_CAMPANHA = 3048716
const FIELD_UTM_CONJUNTO = 3048718
const FIELD_UTM_CRIATIVO = 3048720

export async function onRequestPost(context: any) {
  try {
    const body = await context.request.json()

    // ── Resend ────────────────────────────────────────────────────────────────
    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${context.env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: "Pling Company <onboarding@resend.dev>",
        to: ["plingcompany@gmail.com"],
        subject: `Novo lead (Isca Cardápio): ${body.nome} — ${body.empresa}`,
        html: `
          <h2>Novo lead — Ferramenta de Análise de Cardápio</h2>
          <table style="border-collapse:collapse;width:100%">
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Nome</strong></td><td style="padding:8px;border:1px solid #ddd">${body.nome}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Empresa</strong></td><td style="padding:8px;border:1px solid #ddd">${body.empresa}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Telefone</strong></td><td style="padding:8px;border:1px solid #ddd">${body.telefone}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>E-mail</strong></td><td style="padding:8px;border:1px solid #ddd">${body.email}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Segmento</strong></td><td style="padding:8px;border:1px solid #ddd">${body.segmento}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Faturamento</strong></td><td style="padding:8px;border:1px solid #ddd">${body.faturamento}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>URL Cardápio</strong></td><td style="padding:8px;border:1px solid #ddd">${body.urlCardapio || '—'}</td></tr>
          </table>
        `,
      }),
    })
    const emailData = await emailRes.json() as any

    // ── Kommo ─────────────────────────────────────────────────────────────────
    const token = context.env.KOMMO_TOKEN
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    }
    const base = "https://assesoriaplingcompany.kommo.com/api/v4"

    const payload = [
      {
        source_uid: `isca-cardapio-${Date.now()}`,
        source_name: "Isca Cardápio — Análise IA",
        pipeline_id: 13422715,
        metadata: {
          form_id: "formulario-cardapio",
          form_name: "Análise de Cardápio",
          form_page: "https://produto-isca-cardapio.pages.dev",
          form_sent_at: Math.floor(Date.now() / 1000),
        },
        _embedded: {
          leads: [
            {
              name: body._ctaClicado
                ? `QUENTE - ${body.nome} | ${body.empresa}`
                : `Isca - ${body.nome} | ${body.empresa}`,
              price: 6000,
              custom_fields_values: [
                { field_id: FIELD_SEGMENTO,    values: [{ value: body.segmento    }] },
                { field_id: FIELD_FATURAMENTO, values: [{ value: body.faturamento }] },
              ].filter(f => f.values[0].value),
            },
          ],
          contacts: [
            {
              first_name: body.nome.split(" ")[0],
              last_name: body.nome.split(" ").slice(1).join(" ") || "",
              custom_fields_values: [
                { field_code: "PHONE", values: [{ value: body.telefone, enum_code: "WORK" }] },
                { field_code: "EMAIL", values: [{ value: body.email,    enum_code: "WORK" }] },
                { field_id: FIELD_UTM_ORIGEM,   values: [{ value: body.utm_source   }] },
                { field_id: FIELD_UTM_CAMPANHA, values: [{ value: body.utm_campaign }] },
                { field_id: FIELD_UTM_CONJUNTO, values: [{ value: body.utm_term     }] },
                { field_id: FIELD_UTM_CRIATIVO, values: [{ value: body.utm_content  }] },
              ].filter(f => f.values[0].value),
            },
          ],
        },
      },
    ]

    let kommoData: any = null
    try {
      const kommoRes = await fetch(`${base}/leads/unsorted/forms`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      })
      const text = await kommoRes.text()
      try { kommoData = JSON.parse(text) } catch { kommoData = text }
    } catch (e: any) {
      kommoData = { error: e.message }
    }

    return new Response(JSON.stringify({ ok: true, email: emailData, kommo: kommoData }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }
}
