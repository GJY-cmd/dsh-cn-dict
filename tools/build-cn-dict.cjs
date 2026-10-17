/**
 * 汉语词典词库流水线：下载 → 解压 → 建 SQLite 库。
 *
 * 数据源（均为开源数据；来源与许可见库内 meta 表）：
 *   chinese-xinhua (pwxcoo)  word.json    词语/字条释义（含繁体字、笔画、拼音、部首）
 *                            ci.json      词语释义
 *                            idiom.json   成语：出处、例句、释义、拼音
 *                            xiehouyu.json 歇后语
 *   chinese_dictionary (max32002) Dictionary.json  8.1 万字字级：部首、部首笔画、总笔画、
 *                                                  异体字、同义字、文字组件、三地读音
 *   CC-CEDICT (mdbg.net 官方导出)                 汉英对译
 *
 * 用法： node build-cn-dict.cjs <cacheDir> <outSqlite>
 * 幂等：本地文件大小与远端一致时跳过下载；输出库每次重建。
 */
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const https = require('node:https')
const zlib = require('node:zlib')
const { DatabaseSync } = require('node:sqlite')

const CACHE = process.argv[2]
const OUT = process.argv[3]
if (!CACHE || !OUT) {
  console.error('usage: node build-cn-dict.cjs <cacheDir> <outSqlite>')
  process.exit(2)
}
fs.mkdirSync(CACHE, { recursive: true })

// 代理前缀（同一路径换前缀重试：两个代理互为备份）
// GitHub 代理前缀（公共第三方服务，非本项目所有）。
// 能直连 GitHub 的环境请置为空数组 [] 以改用直连；不信任代理请自行下载文件
// 放进缓存目录（脚本按字节数校验，已就绪的文件不会再下载）。
const PROXIES = ['https://ghproxy.net/', 'https://gh-proxy.com/']

/** 直连或经代理的下载任务。bytes 仅在确切知晓时填写，否则 0（只校验非空）。 */
const SOURCES = [
  { file: 'word.json', raw: 'pwxcoo/chinese-xinhua/master/data/word.json', bytes: 27354320 },
  { file: 'ci.json', raw: 'pwxcoo/chinese-xinhua/master/data/ci.json', bytes: 26129191 },
  { file: 'idiom.json', raw: 'pwxcoo/chinese-xinhua/master/data/idiom.json', bytes: 10319857 },
  { file: 'xiehouyu.json', raw: 'pwxcoo/chinese-xinhua/master/data/xiehouyu.json', bytes: 0 },
  { file: 'max32002-Dictionary.json', raw: 'max32002/chinese_dictionary/master/Dictionary.json', bytes: 33190508 },
  { file: 'cedict.txt.gz', url: 'https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz', bytes: 3981100 },
]

function httpGet(url, dest, expected, redirects = 5) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    const req = mod.get(url, { headers: { 'User-Agent': 'dsh-cn-dict' }, timeout: 180000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume()
        if (redirects <= 0) return reject(new Error('too many redirects'))
        return resolve(httpGet(new URL(res.headers.location, url).toString(), dest, expected, redirects - 1))
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)) }
      const tmp = dest + '.part'
      const out = fs.createWriteStream(tmp)
      let got = 0
      res.on('data', (c) => { got += c.length })
      res.pipe(out)
      out.on('error', reject)
      out.on('finish', () => out.close(() => {
        // 只拒绝"比预期短"的下载；比预期长说明本地记录过时，以远端为准。
        if (expected > 0 && got < expected) {
          fs.rmSync(tmp, { force: true })
          return reject(new Error(`short read: got ${got}, expected ${expected}`))
        }
        fs.renameSync(tmp, dest)
        resolve(got)
      }))
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
  })
}

function candidates(source) {
  if (source.url) return [source.url]
  return PROXIES.map((p) => `${p}https://raw.githubusercontent.com/${source.raw}`)
}

async function ensureSources() {
  for (const s of SOURCES) {
    const dest = path.join(CACHE, s.file)
    if (fs.existsSync(dest) && fs.statSync(dest).size >= (s.bytes || 1)) {
      console.log(`[cache] ${s.file} 已就绪 (${(fs.statSync(dest).size / 1048576).toFixed(2)} MB)`)
      continue
    }
    const urls = candidates(s)
    let lastError
    let done = false
    for (let round = 1; round <= 3 && !done; round++) {
      for (const url of urls) {
        try {
          const t0 = Date.now()
          const bytes = await httpGet(url, dest, s.bytes)
          console.log(`[get]   ${s.file} ${(bytes / 1048576).toFixed(2)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
          done = true
          break
        } catch (error) {
          lastError = error
          console.log(`[get]   ${s.file} 失败(${url.slice(0, 34)}...): ${error.message}`)
          await new Promise((r) => setTimeout(r, 1500 * round))
        }
      }
    }
    if (!done) throw new Error(`${s.file} 下载失败: ${lastError?.message}`)
  }
}

const readJson = (file) => JSON.parse(fs.readFileSync(path.join(CACHE, file), 'utf8'))
const norm = (s) => String(s ?? '').normalize('NFKC').trim()
const int = (s) => { const n = Number.parseInt(String(s ?? '').replace(/[^\d-]/g, ''), 10); return Number.isFinite(n) ? n : 0 }

function build() {
  if (fs.existsSync(OUT)) fs.rmSync(OUT, { force: true })
  for (const s of ['-wal', '-shm']) fs.rmSync(OUT + s, { force: true })

  const db = new DatabaseSync(OUT)
  db.exec('pragma journal_mode = WAL')
  db.exec('pragma synchronous = OFF')
  db.exec('pragma cache_size = -131072')

  db.exec(`
  create table words (
    id integer primary key,
    kind text not null,               -- word | char
    word text not null,
    word_key text not null,
    oldword text not null default '',
    strokes integer not null default 0,
    pinyin text not null default '',
    radicals text not null default '',
    explanation text not null default '',
    extra text not null default ''
  );
  create table chars (
    id integer primary key,
    ch text not null,
    ch_key text not null,
    unicode_hex text not null default '',
    radical text not null default '',
    radical_count integer not null default 0,
    strokes_count integer not null default 0,
    strokes_total integer not null default 0,
    alternate text not null default '',
    semantic_variant text not null default '',
    components text not null default '',
    pinyin text not null default '',
    pinyin_cantonese text not null default '',
    pinyin_minnan text not null default ''
  );
  create table ci (
    id integer primary key,
    word text not null,
    word_key text not null,
    explanation text not null default ''
  );
  create table idioms (
    id integer primary key,
    word text not null,
    word_key text not null,
    pinyin text not null default '',
    explanation text not null default '',
    derivation text not null default '',
    example text not null default '',
    abbreviation text not null default ''
  );
  create table xiehouyu (
    id integer primary key,
    riddle text not null,
    riddle_key text not null,
    answer text not null default '',
    explanation text not null default ''
  );
  create table english (
    id integer primary key,
    trad text not null,
    simp text not null,
    simp_key text not null,
    pinyin text not null default '',
    gloss text not null default ''
  );
  create table variants (from_key text not null, to_key text not null);
  create table simp_of (trad_key text primary key, simp_key text not null);
  create table meta (k text primary key, v text not null);
  `)

  const insWord = db.prepare('insert into words (kind, word, word_key, oldword, strokes, pinyin, radicals, explanation, extra) values (?,?,?,?,?,?,?,?,?)')
  const insChar = db.prepare(`insert into chars (ch, ch_key, unicode_hex, radical, radical_count, strokes_count, strokes_total,
    alternate, semantic_variant, components, pinyin, pinyin_cantonese, pinyin_minnan) values (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  const insCi = db.prepare('insert into ci (word, word_key, explanation) values (?,?,?)')
  const insIdiom = db.prepare('insert into idioms (word, word_key, pinyin, explanation, derivation, example, abbreviation) values (?,?,?,?,?,?,?)')
  const insXhy = db.prepare('insert into xiehouyu (riddle, riddle_key, answer, explanation) values (?,?,?,?)')
  const insEn = db.prepare('insert into english (trad, simp, simp_key, pinyin, gloss) values (?,?,?,?,?)')
  const insVar = db.prepare('insert into variants (from_key, to_key) values (?,?)')

  // ── 词语/字条（xinhua） ─────────────────────────────────────────────────
  const known = new Set(['word', 'oldword', 'strokes', 'pinyin', 'radicals', 'explanation'])
  let wCount = 0
  let cCount = 0
  db.exec('begin')
  for (const row of readJson('word.json')) {
    const w = norm(row.word)
    if (!w) continue
    const old = norm(row.oldword)
    const isChar = [...w].length === 1
    const rest = {}
    for (const [k, v] of Object.entries(row)) if (!known.has(k)) rest[k] = v
    insWord.run(isChar ? 'char' : 'word', w, w, old, int(row.strokes), norm(row.pinyin), norm(row.radicals), norm(row.explanation), JSON.stringify(rest))
    if (old && old !== w) insVar.run(old, w)
    if (isChar) cCount++; else wCount++
  }
  db.exec('commit')
  console.log(`[build] xinhua: 词语 ${wCount}，单字 ${cCount}`)

  // ── 字级资料（max32002：部首/笔画/异体/同义/组件/三地读音） ──────────────
  const maxDict = readJson('max32002-Dictionary.json')
  let charFull = 0
  db.exec('begin')
  for (const [key, v] of Object.entries(maxDict)) {
    if (!v || typeof v !== 'object') continue
    const ch = norm(v.text ?? key)
    if (!ch) continue
    insChar.run(
      ch, ch,
      norm(v.unicode_hex),
      norm(v.radical),
      int(v.radical_count),
      int(v.strokes_count),
      int(v.strokes_total),
      Array.isArray(v.alternate) ? v.alternate.join(' ') : norm(v.alternate),
      Array.isArray(v.semantic_variant) ? v.semantic_variant.join(' ') : norm(v.semantic_variant),
      v.component && typeof v.component === 'object' ? Object.entries(v.component).map(([k2, val]) => `${k2}:${val}`).join(' ') : '',
      Array.isArray(v.pronunciation_mandarin) ? v.pronunciation_mandarin.join(' ') : norm(v.pronunciation_mandarin),
      Array.isArray(v.pronunciation_cantonese) ? v.pronunciation_cantonese.join(' ') : norm(v.pronunciation_cantonese),
      Array.isArray(v.pronunciation_southern_min) ? v.pronunciation_southern_min.join(' ') : norm(v.pronunciation_southern_min),
    )
    charFull++
  }
  db.exec('commit')
  console.log(`[build] max32002 字级: ${charFull}`)

  // ── 词语（ci） ───────────────────────────────────────────────────────────
  const rawCi = readJson('ci.json')
  db.exec('begin')
  let ciCount = 0
  for (const row of rawCi) {
    const w = norm(row.ci ?? row.word)
    if (!w) continue
    insCi.run(w, w, norm(row.explanation))
    ciCount++
  }
  db.exec('commit')
  console.log(`[build] ci: ${ciCount}`)

  // ── 成语 ─────────────────────────────────────────────────────────────────
  db.exec('begin')
  let idiomCount = 0
  for (const row of readJson('idiom.json')) {
    const w = norm(row.word)
    if (!w) continue
    insIdiom.run(w, w, norm(row.pinyin), norm(row.explanation), norm(row.derivation), norm(row.example), norm(row.abbreviation))
    idiomCount++
  }
  db.exec('commit')
  console.log(`[build] idioms: ${idiomCount}`)

  // ── 歇后语 ───────────────────────────────────────────────────────────────
  db.exec('begin')
  let xhyCount = 0
  for (const row of readJson('xiehouyu.json')) {
    const riddle = norm(row.riddle)
    if (!riddle) continue
    insXhy.run(riddle, riddle, norm(row.answer), norm(row.explanation))
    xhyCount++
  }
  db.exec('commit')
  console.log(`[build] xiehouyu: ${xhyCount}`)

  // ── CC-CEDICT（汉英） ────────────────────────────────────────────────────
  const text = zlib.gunzipSync(fs.readFileSync(path.join(CACHE, 'cedict.txt.gz'))).toString('utf8')
  db.exec('begin')
  let enCount = 0
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^(\S+)\s+(\S+)\s+\[([^\]]*)\]\s+\/(.*)\/\s*$/)
    if (!m) continue
    const [, trad, simp, pinyin, defs] = m
    insEn.run(trad, simp, norm(simp), norm(pinyin), defs.replace(/\//g, '；'))
    if (trad !== simp) insVar.run(trad, simp)
    enCount++
  }
  db.exec('commit')
  console.log(`[build] CC-CEDICT: ${enCount}`)

  console.log('[build] 建索引 ...')
  db.exec(`
  create index words_key on words(word_key);
  create index words_kind on words(kind);
  create index chars_key on chars(ch_key);
  create index chars_radical on chars(radical);
  create index chars_strokes on chars(strokes_total);
  create index ci_key on ci(word_key);
  create index idioms_key on idioms(word_key);
  create index xiehouyu_key on xiehouyu(riddle_key);
  create index english_key on english(simp_key);
  create index variants_from on variants(from_key);
  `)

  console.log('[build] 繁简映射 ...')
  db.exec(`insert or replace into simp_of (trad_key, simp_key)
           select from_key, min(to_key) from variants where from_key <> to_key group by from_key`)

  console.log('[build] FTS5 全文索引 ...')
  db.exec(`create virtual table search_fts using fts5(body, table_name, row_id, tokenize="unicode61 remove_diacritics 2")`)
  for (const [table, cols] of [
    ['words', `word || ' ' || oldword || ' ' || pinyin || ' ' || explanation`],
    ['chars', `ch || ' ' || pinyin || ' ' || radical || ' ' || alternate || ' ' || semantic_variant || ' ' || components`],
    ['ci', `word || ' ' || explanation`],
    ['idioms', `word || ' ' || pinyin || ' ' || explanation || ' ' || derivation`],
    ['xiehouyu', `riddle || ' ' || answer || ' ' || explanation`],
    ['english', `simp || ' ' || trad || ' ' || pinyin || ' ' || gloss`],
  ]) {
    db.exec(`insert into search_fts (body, table_name, row_id) select ${cols}, '${table}', id from ${table}`)
  }

  const counts = {}
  for (const t of ['words', 'chars', 'ci', 'idioms', 'xiehouyu', 'english', 'variants', 'simp_of']) {
    counts[t] = db.prepare(`select count(*) c from ${t}`).get().c
  }
  for (const [k, v] of [
    ['sources', 'chinese-xinhua (pwxcoo) + chinese_dictionary (max32002) + CC-CEDICT (mdbg.net)'],
    ['built_at', new Date().toISOString()],
    ...Object.entries(counts).map(([k2, v2]) => [`count_${k2}`, String(v2)]),
  ]) db.prepare('insert into meta (k, v) values (?,?)').run(k, v)

  db.exec('pragma journal_mode = DELETE')
  db.exec('vacuum')
  db.close()
  console.log(`[build] 完成: ${JSON.stringify(counts)}`)
  console.log(`[build] 库文件: ${OUT} ${(fs.statSync(OUT).size / 1048576).toFixed(1)} MB`)
}

;(async () => {
  const t0 = Date.now()
  await ensureSources()
  build()
  console.log(`[done] 总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
})().catch((error) => { console.error('[fail]', error); process.exit(1) })
