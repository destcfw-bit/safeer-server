function primitiveId(value){
  if(value==null)return '';
  if(typeof value==='string'||typeof value==='number')return String(value).trim();
  return '';
}

export function isWahaLid(value){
  const raw=primitiveId(value)||(value&&typeof value==='object'
    ?primitiveId(value._serialized||value.serialized||value.id||value.jid||value.lid)
    :'');
  return /@lid$/i.test(raw);
}

export function normalizeWahaPhoneJid(value,{allowBare=false}={}){
  if(value==null)return '';
  if(typeof value==='object'){
    const server=String(value.server||value._server||'').toLowerCase();
    const user=String(value.user||value._user||'').replace(/\D/g,'');
    if(user&&(server==='c.us'||server==='s.whatsapp.net'))return `${user}@c.us`;
    const candidates=[
      value.pn,value.phoneNumber,value.phone,value.number,value.phoneId,
      value.participantPn,value.participantPN,value.participantPhone,value.participantAlt,
      value.authorPn,value.authorPhone,value.authorAlt,
      value.senderPn,value.senderPhone,value.senderAlt,
      value._serialized,value.serialized,value.id,value.chatId,value.jid
    ];
    for(const candidate of candidates){
      const normalized=normalizeWahaPhoneJid(candidate,{allowBare});
      if(normalized)return normalized;
    }
    return '';
  }
  const raw=String(value||'').trim();
  const jid=raw.match(/^(\d{8,15})@(c\.us|s\.whatsapp\.net)$/i);
  if(jid)return `${jid[1]}@c.us`;
  if(allowBare&&/^\+?\d{8,15}$/.test(raw))return `${raw.replace(/\D/g,'')}@c.us`;
  return '';
}

function explicitPhoneFields(source){
  if(!source||typeof source!=='object')return [];
  return [
    source.pn,source.phoneNumber,source.phone,source.number,source.phoneId,
    source.participantPn,source.participantPN,source.participantPhone,source.participantAlt,
    source.authorPn,source.authorPhone,source.authorAlt,
    source.senderPn,source.senderPhone,source.senderAlt,
    source.participant?.pn,source.participant?.phoneNumber,source.participant?.phone,
    source.author?.pn,source.author?.phoneNumber,source.author?.phone,
    source.sender?.pn,source.sender?.phoneNumber,source.sender?.phone
  ];
}

// WAHA WEBJS may expose the same participant twice: a privacy LID in
// `participant` and a real phone JID in `participantAlt`/`pn`. Always inspect
// the explicit phone fields first so the LID can never win by array order.
export function extractWahaDirectPhoneId(payload={},event={}){
  const nested=[
    payload,payload?._data,payload?.before,payload?.before?._data,
    payload?.after,payload?.after?._data,payload?.reaction
  ];
  for(const source of nested){
    for(const candidate of explicitPhoneFields(source)){
      const normalized=normalizeWahaPhoneJid(candidate,{allowBare:true});
      if(normalized)return normalized;
    }
  }
  const jidCandidates=[
    payload?.participant,payload?.author,payload?.sender,
    payload?._data?.author,payload?._data?.participant,payload?._data?.id?.participant,
    payload?.before?.participant,payload?.before?.author,payload?.before?._data?.author,
    payload?.after?.participant,payload?.after?.author,payload?.after?._data?.author,
    payload?.fromMe?event?.me?.id:null
  ];
  for(const candidate of jidCandidates){
    const normalized=normalizeWahaPhoneJid(candidate);
    if(normalized)return normalized;
  }
  return '';
}
