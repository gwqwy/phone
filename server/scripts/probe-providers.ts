/** 诊断：打印 ~/.zcode/v2/provider_config.json 的 provider 规则（key 脱敏） */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const file = path.join(homedir(), '.zcode', 'v2', 'provider_config.json')
const c = JSON.parse(readFileSync(file, 'utf8')) as {
  config?: {
    providerConfigRules?: { providerRules?: Record<string, unknown>[] }
    modelConfigRules?: Record<string, unknown>
  }
}
const rules = c.config?.providerConfigRules?.providerRules ?? []
for (const r of rules) {
  const cfg = (r.config ?? {}) as Record<string, unknown>
  const access = cfg.access as { type?: string; apiKey?: string } | undefined
  console.log(
    JSON.stringify({
      providerId: r.providerId,
      name: r.providerName,
      access: access ? { type: access.type, hasKey: Boolean(access.apiKey) } : null,
      api: cfg.api,
      models: cfg.personalModelIds,
      group: cfg.group,
      templateId: r.templateId,
    }),
  )
}
console.log('modelConfigRules:', JSON.stringify(c.config?.modelConfigRules).slice(0, 400))
