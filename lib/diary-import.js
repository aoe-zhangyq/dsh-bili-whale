import fs from 'node:fs'
import path from 'node:path'

// Only dated level-two headings delimit records. Other headings belong to the
// current record. Times are the diary's explicit Beijing wall clock, not mtime.
export function parseDiaryMarkdown(text, book) {
  const entries=[],warnings=[]
  const lines=text.replace(/^\uFEFF/,'').replace(/\r\n/g,'\n').split('\n')
  let current=null,fence=null
  const finish=()=>{
    if(!current)return
    const content=current.lines.join('\n').trim()
    if(!current.at) warnings.push({book,line:current.line,reason:'日期或时间不明确，未导入'})
    else if(content.length>11000) warnings.push({book,line:current.line,reason:'条目超过 11000 字符，未导入'})
    else entries.push({book,at:current.at,content})
  }
  for(let i=0;i<lines.length;i++) {
    const line=lines[i],marker=line.match(/^\s{0,3}(`{3,}|~{3,})/)
    if(marker) {
      if(!fence)fence=marker[1]
      else if(marker[1][0]===fence[0] && marker[1].length>=fence.length)fence=null
      if(current)current.lines.push(line)
      continue
    }
    const heading=!fence && line.match(/^##\s+(\d{4}-\d{2}-\d{2})(?=\s|$|[·（(])/)
    if(heading) {
      finish()
      const time=line.slice(heading[0].length).match(/^[\s·]*(?:(凌晨|早上|上午|中午|下午|傍晚|晚上|夜里|深夜)\s*)?(\d{1,2}):([0-5]\d)(?=$|\s|[（(])/)
      let at=null
      if(time) {
        let hour=Number(time[2])
        if(['下午','傍晚','晚上'].includes(time[1]) && hour>=1 && hour<12)hour+=12
        if(time[1]==='中午' && hour>=1 && hour<11)hour+=12
        if(hour<24) {
          const candidate=`${heading[1]}T${String(hour).padStart(2,'0')}:${time[3]}:00+08:00`
          const value=Date.parse(candidate)
          if(Number.isFinite(value) && new Date(value+8*3600000).toISOString().slice(0,10)===heading[1])at=candidate
        }
      }
      current={at,line:i+1,lines:[line]}
    } else if(current)current.lines.push(line)
  }
  finish()
  if(!current && text.trim())warnings.push({book,line:1,reason:'没有带日期和时间的二级标题，未导入'})
  return {entries,warnings}
}

export function readLegacyDiaries(home) {
  const result={entries:[],warnings:[]}
  for(const [book,name] of [['public','whale-diary.md'],['private','whale-diary-private.md']]) {
    let text
    try {text=fs.readFileSync(path.join(home,name),'utf8')} catch(error) {if(error.code==='ENOENT')continue;throw error}
    const parsed=parseDiaryMarkdown(text,book)
    result.entries.push(...parsed.entries);result.warnings.push(...parsed.warnings)
  }
  return result
}
