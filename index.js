/**
 * @GJY-cmd/dsh-cn-dict — 汉语词典查询插件（预设侧插件）。
 *
 * 注册一个模型可见工具 `dict_lookup`，直连本地 SQLite 词库：
 *   字级  部首、部首笔画、总笔画、异体字、同义字、文字组件、普通话/粤语/闽南音
 *   词语  释义（现代汉语）
 *   成语  释义、出处、例句、拼音
 *   歇后语 谜面 → 谜底
 *   汉英  中文 → 英文对译（CC-CEDICT）
 *
 * 只读：库以 readOnly 打开；查询路径全部走预编译语句。
 * 繁体输入自动折到简体（simp_of 表）。
 */
import { DatabaseSync } from 'node:sqlite'

export const name = 'cn-dict'
/** tools 是工具注册表；systemPrompt 提供词典纪律提示词节。 */
export const inject = ['tools', 'systemPrompt']

const DEFAULT_DB = process.env.DSH_CN_DICT_DB ?? ''

/**
 * 行 config 的 schema。
 *
 * 宿主按 Standard Schema 规范校验（读取 `Config['~standard'].validate(config)`），
 * 因此这里必须提供该接口。刻意手写而不 import schemastery：本包经 junction 链接进
 * profile 后，Node 会按**真实路径**解析依赖，而源码目录没有 node_modules，
 * 任何外部依赖都会导致 "Cannot find package" 而使整个预设加载失败。
 * 零依赖是这个插件能稳定加载的前提。
 */
const SPEC = {
  dbPath: { type: 'string', description: '汉语词典 SQLite 库路径' },
  defaultLimit: { type: 'number', description: '默认返回条数上限（1–30）', min: 1, max: 30 },
  includeEnglish: { type: 'boolean', description: '中文条目是否附英文对译' },
}

export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-cn-dict',
    validate(value) {
      const input = value === null || value === undefined ? {} : value
      if (typeof input !== 'object' || Array.isArray(input)) {
        return { issues: [{ message: 'config 必须是对象', path: [] }] }
      }
      const out = {}
      const issues = []
      for (const [key, spec] of Object.entries(SPEC)) {
        const raw = input[key]
        if (raw === undefined || raw === null) {
          if (key === 'dbPath') out[key] = DEFAULT_DB
          else if (key === 'defaultLimit') out[key] = 5
          else out[key] = true
          continue
        }
        if (spec.type === 'string') {
          if (typeof raw !== 'string') issues.push({ message: `${key} 必须是字符串`, path: [key] })
          else out[key] = raw
        } else if (spec.type === 'number') {
          if (typeof raw !== 'number' || !Number.isFinite(raw)) issues.push({ message: `${key} 必须是数字`, path: [key] })
          else if (raw < spec.min || raw > spec.max) issues.push({ message: `${key} 超出范围 ${spec.min}–${spec.max}`, path: [key] })
          else out[key] = Math.floor(raw)
        } else if (spec.type === 'boolean') {
          if (typeof raw !== 'boolean') issues.push({ message: `${key} 必须是布尔值`, path: [key] })
          else out[key] = raw
        }
      }
      if (!out.dbPath) out.dbPath = DEFAULT_DB
      if (out.defaultLimit === undefined) out.defaultLimit = 5
      if (out.includeEnglish === undefined) out.includeEnglish = true
      return issues.length ? { issues } : { value: out }
    },
  },
}

let db = null
let statements = null

function openDb(dbPath) {
  if (db) return db
  db = new DatabaseSync(dbPath, { readOnly: true })
  statements = {
    char: db.prepare('select * from chars where ch_key = ?'),
    word: db.prepare('select * from words where word_key = ? order by kind'),
    ci: db.prepare('select * from ci where word_key = ?'),
    idiom: db.prepare('select * from idioms where word_key = ?'),
    xhy: db.prepare('select * from xiehouyu where riddle_key = ?'),
    en: db.prepare('select * from english where simp_key = ?'),
    simpOf: db.prepare('select simp_key from simp_of where trad_key = ?'),
    prefix: db.prepare('select word from words where word_key like ? order by length(word), word limit ?'),
    ciPrefix: db.prepare('select word from ci where word_key like ? limit ?'),
    fts: db.prepare('select table_name, row_id from search_fts where search_fts match ? limit ?'),
    byId: {
      words: db.prepare('select * from words where id = ?'),
      chars: db.prepare('select * from chars where id = ?'),
      ci: db.prepare('select * from ci where id = ?'),
      idioms: db.prepare('select * from idioms where id = ?'),
      xiehouyu: db.prepare('select * from xiehouyu where id = ?'),
      english: db.prepare('select * from english where id = ?'),
    },
    charChildren: db.prepare("select ch, pinyin, strokes_total, radical from chars where components like ? limit 40"),
  }
  return db
}

const s = (v) => (v === null || v === undefined ? '' : String(v))

/** 繁体 → 简体（查不到原样返回）。 */
function toSimp(key) {
  if (!statements) return key
  const hit = statements.simpOf.get(key)
  return hit ? s(hit.simp_key) : key
}

/**
 * 释义档位。源数据的 explanation 是无差别长文（古文例句、交叉引用、"又如"串），
 * 单条可达上千字符；按行截断即可去掉绝大部分噪声，同时保住第一义项。
 *   tiny   一句话（约 40 字）——仅用于"同一表达已被别的块详述"时的去重
 *   brief  第一义项（约 80 字）
 *   normal 前 3 行义项（约 240 字）
 *   full   完整原文
 */
const DETAILS = {
  tiny: { lines: 1, chars: 40 },
  brief: { lines: 1, chars: 80 },
  normal: { lines: 3, chars: 240 },
  full: { lines: Infinity, chars: Infinity },
}
/** 默认档位：brief。多数提问是"怎么读/什么意思"，一两个义项足够；full 要显式要。 */
const DEFAULT_DETAIL = 'brief'
const asDetail = (v) => (v === undefined ? DEFAULT_DETAIL : (DETAILS[v] ? v : DEFAULT_DETAIL))

/** 按行数/字数截断长释义；行内换行压成空格。 */
function cut(text, detail) {
  const d = DETAILS[asDetail(detail)]
  let value = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!value) return ''
  if (d.lines !== Infinity) {
    const parts = String(text ?? '').split(/\s*\n+\s*/).map((x) => x.trim()).filter(Boolean)
    if (parts.length > 1) value = parts.slice(0, d.lines).join('；')
  }
  if (value.length > d.chars) value = value.slice(0, d.chars) + '…'
  return value
}

function fmtChar(row, wordRow, x) {
  const pinyin = row.pinyin || wordRow?.pinyin || ''
  const lines = [`${row.ch}　${pinyin || '（无注音）'}`]
  if (row.unicode_hex) lines.push(`  Unicode：U+${s(row.unicode_hex).toUpperCase()}`)
  if (row.radical) lines.push(`  部首：${row.radical}（${row.radical_count} 画）　总笔画：${row.strokes_total}　部首外笔画：${row.strokes_count}`)
  if (row.alternate) lines.push(`  异体字：${row.alternate}`)
  if (row.semantic_variant) lines.push(`  同义字：${row.semantic_variant}`)
  if (row.components) lines.push(`  文字组件：${row.components}`)
  if (row.pinyin_cantonese) lines.push(`  粤语：${row.pinyin_cantonese}`)
  if (row.pinyin_minnan) lines.push(`  闽南语：${row.pinyin_minnan}`)
  if (wordRow?.explanation) lines.push(`  释义：${cut(wordRow.explanation, x)}`)
  return lines.join('\n')
}

function fmtWord(row, english, x) {
  const lines = [`${row.word}${row.oldword && row.oldword !== row.word ? `（${row.oldword}）` : ''}　${row.pinyin || ''}`]
  if (row.radicals) lines.push(`  部首：${row.radicals}　笔画：${row.strokes}`)
  if (row.explanation) lines.push(`  释义：${cut(row.explanation, x)}`)
  if (english.length) lines.push(`  英文：${english.map((e) => e.gloss).join('；')}`)
  return lines.join('\n')
}

function fmtCi(row, x) {
  return `${row.word}\n  释义：${cut(row.explanation, x)}`
}

function fmtIdiom(row, english, x) {
  const lines = [`${row.word}　${row.pinyin || ''}`]
  if (row.explanation) lines.push(`  释义：${cut(row.explanation, x)}`)
  if (row.derivation && asDetail(x) !== 'brief') lines.push(`  出处：${cut(row.derivation, x)}`)
  if (row.example && asDetail(x) === 'full') lines.push(`  例句：${cut(row.example, x)}`)
  if (english.length) lines.push(`  英文：${english.map((e) => e.gloss).join('；')}`)
  return lines.join('\n')
}

function fmtXhy(row, x) {
  return `${row.riddle}\n  谜底：${row.answer}${row.explanation && asDetail(x) !== 'brief' ? `\n  说明：${cut(row.explanation, x)}` : ''}`
}

function fmtEnglish(rows) {
  return rows.map((e) => `${e.trad}${e.trad !== e.simp ? ` / ${e.simp}` : ''}　${e.pinyin || ''}\n  ${e.gloss}`).join('\n')
}

/** 汇总一条查询结果；返回 { text, hits }。 */
function lookup(query, options) {
  const limit = Math.max(1, Math.min(Number(options?.limit) || 5, 20))
  const wantEnglish = options?.english !== false
  const x = asDetail(options?.detail)
  const raw = String(query ?? '').normalize('NFKC').trim()
  if (!raw) return { text: '查询词为空。', hits: 0 }
  const key = toSimp(raw)
  const blocks = []
  let hits = 0

  const chars = statements.char.get(key)
  const words = statements.word.all(key)
  // 字级资料（max32002）补部首/笔画/组件，xinhua 词条补注音与释义。两者对单字
  // 常常描述同一条目，早期版本会各输出一遍（同样的释义出现两次）——这里把
  // xinhua 那条并入【字】块，并在下面的循环里跳过它，避免重复计费。
  const charWord = words.find((w) => w.kind === 'char')
  const mergedWordKeys = new Set()
  if (chars) {
    blocks.push(`【字】\n${fmtChar(chars, charWord, x)}`)
    hits++
    if (charWord) mergedWordKeys.add(charWord.word_key)
  }

  for (const row of words) {
    if (mergedWordKeys.has(row.word_key)) continue
    const en = wantEnglish ? statements.en.all(row.word_key) : []
    blocks.push(`【词条】\n${fmtWord(row, en, x)}`)
    hits++
  }

  const ci = statements.ci.get(key)
  const idiom = statements.idiom.get(key)
  // 成语在 brief 档下自己会给出完整释义，【词语】那份是同一表达的重复长文
  // （成语释义往往引同一个典故），只留一句足以表明是同一词，避免重复计费。
  if (ci) { blocks.push(`【词语】\n${fmtCi(ci, idiom ? 'tiny' : x)}`); hits++ }

  if (idiom) {
    const en = wantEnglish ? statements.en.all(idiom.word_key) : []
    blocks.push(`【成语】\n${fmtIdiom(idiom, en, x)}`)
    hits++
  }

  const xhy = statements.xhy.get(key)
  if (xhy) { blocks.push(`【歇后语】\n${fmtXhy(xhy, x)}`); hits++ }

  // 汉英对译：ASCII 词无条件查；中文词在无中文命中时兜底查
  const isAscii = /^[\x20-\x7e]+$/.test(key)
  if (wantEnglish && (isAscii || hits === 0)) {
    const en = statements.en.all(key)
    if (en.length) { blocks.push(`【汉英】\n${fmtEnglish(en.slice(0, limit))}`); hits += en.length }
  }

  if (hits === 0) {
    // 前缀提示：告诉模型"未收录"，并给出近似词条，便于改查或改用自身知识
    const prefix = statements.prefix.all(`${key}%`, limit).map((r) => r.word)
    const ciPrefix = statements.ciPrefix.all(`${key}%`, limit).map((r) => r.word)
    const near = [...new Set([...prefix, ...ciPrefix])].slice(0, limit)
    if (near.length) {
      return { text: `词库未收录「${raw}」。前缀相近的词条：${near.join('、')}`, hits: 0 }
    }
    return { text: `词库未收录「${raw}」，也没有前缀相近的词条。请用你自身的知识解释，并注明这是模型释义而非词库条目。`, hits: 0 }
  }

  const header = key === raw ? '' : `（「${raw}」按简体「${key}」查询）\n`
  return { text: header + blocks.slice(0, limit + 1).join('\n\n'), hits }
}

/** 全文检索：按内容找词（如按释义找词、按部件找字）。 */
function search(query, options) {
  const limit = Math.max(1, Math.min(Number(options?.limit) || 8, 30))
  const x = asDetail(options?.detail)
  const term = String(query ?? '').trim()
  if (!term) return '检索词为空。'
  let rows
  try {
    rows = statements.fts.all(term, limit)
  } catch {
    return `全文检索表达式无法解析：「${term}」。可尝试更短的关键词。`
  }
  if (!rows.length) return `全文检索「${term}」无结果。`
  const out = []
  for (const r of rows) {
    const row = statements.byId[r.table_name]?.get(r.row_id)
    if (!row) continue
    if (r.table_name === 'words') out.push(fmtWord(row, [], x))
    else if (r.table_name === 'chars') out.push(fmtChar(row, null, x))
    else if (r.table_name === 'ci') out.push(fmtCi(row, x))
    else if (r.table_name === 'idioms') out.push(fmtIdiom(row, [], x))
    else if (r.table_name === 'xiehouyu') out.push(fmtXhy(row, x))
    else if (r.table_name === 'english') out.push(fmtEnglish([row]))
  }
  return out.join('\n\n')
}

export function apply(ctx, config = {}) {
  const dbPath = s(config.dbPath) || s(process.env.DSH_CN_DICT_DB) || DEFAULT_DB
  const defaultLimit = Number(config.defaultLimit) || 5

  ctx.tools.register({
    name: 'dict_lookup',
    description: [
      '本地汉语词典（离线词库，非模型记忆）。覆盖：字（部首/笔画/异体字/组件/粤语闽南音）、词语释义、成语（释义+出处+例句）、歇后语、汉英对译。繁体输入自动折简。',
      '',
      'mode=search 为全文检索（按释义找词、按部件找字）。detail 默认 brief（第一义项），要完整释义或例句用 full。',
      '作答前先查；词库未收录时才用自身知识，并标注「模型释义（词库未收录）」。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        word: { type: 'string', description: '要查的字或词' },
        mode: { type: 'string', enum: ['lookup', 'search'], description: 'lookup=精确查词（默认）；search=全文检索' },
        detail: { type: 'string', enum: ['brief', 'normal', 'full'], description: '释义详细度，默认 brief' },
        limit: { type: 'integer', minimum: 1, maximum: 30, description: '返回条数上限' },
        english: { type: 'boolean', description: '是否附英文对译，默认 true' },
      },
      required: ['word'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      try {
        openDb(dbPath)
      } catch (error) {
        return { text: `词库打不开（${dbPath}）：${error.message}。请检查库文件是否存在，或重新运行建库脚本。` }
      }
      const mode = args?.mode === 'search' ? 'search' : 'lookup'
      const limit = args?.limit ?? defaultLimit
      const english = args?.english !== false
      const detail = asDetail(args?.detail)
      const text = mode === 'search'
        ? search(args?.word, { limit, detail })
        : lookup(args?.word, { limit, english, detail }).text
      return { text }
    },
  })

  // 词典模式的行为约定：只用词库事实，未收录时标明来源。
  if (ctx.systemPrompt?.section) {
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'cn-dict-discipline',
      order: 50,
      text: '本会话为「汉语词典」模式。汉语字词的释义/读音/部首/笔画/出处一律先经 dict_lookup 取词库事实；词库未收录的补充内容须单独标注「模型释义（词库未收录）」，不与词库内容混排、不把记忆说成词库条目。',
    }), 'cn-dict: prompt section')
  }
}
