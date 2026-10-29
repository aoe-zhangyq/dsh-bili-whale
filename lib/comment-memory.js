import { recordCommentMessage } from './dm-memory.js'
import { resolveLatestReply } from '../tools/lib/msgfeed.mjs'
import { openVikingSettings } from './openviking.js'
import { DSH_HOME } from '../tools/lib/paths.mjs'
import path from 'node:path'

// Inbox content is only a notification. Attribute a message only after reading
// the exact platform comment by its author MID and rpid.
export async function recordInboxComment(item, {owner, headers, resolve = resolveLatestReply, ...options} = {}) {
  const home = options.home || DSH_HOME
  const settings = options.settings === undefined ? openVikingSettings(process.env, path.join(home, 'whale-openviking.json')) : options.settings
  if (!settings) return false
  if (!item.mid || !item.oid || !item.parent) return false
  const root = item.root && String(item.root) !== '0' ? String(item.root) : String(item.parent)
  const message = await resolve({business: item.business, oid: item.oid, root,
    mid: item.mid, parentRpid: item.parent, headers})
  if (!message?.exact || String(message.rpid) !== String(item.parent) || !message.text?.trim() || !(message.ctime > 0)) return false
  const bvid = String(item.uri || '').match(/\bBV[0-9A-Za-z]{10}\b/)?.[0]
  return recordCommentMessage({mid: item.mid, name: item.who, isOwner: String(item.mid) === String(owner || ''),
    type: [11, 17].includes(Number(item.business)) ? Number(item.business) : 1,
    oid: item.oid, root, id: message.rpid, bvid, content: message.text, createdAt: message.ctime * 1000}, {...options, home, settings})
}
