import React from 'react';
import {Pencil,Pin,Eye,EyeOff,Folder,GitFork,Copy,Archive,Square} from 'lucide-react';
import {MenuItem,MenuDivider} from './menu.jsx';
export function SessionMenuItems({session,state,t,onAction}){
 const busy=session.running||['running','waiting','uncertain'].includes(session.runRecovery?.status),caps=state.engine?.capabilities??{};
 return <><MenuItem icon={Pencil} label={t('rename')} onClick={()=>onAction('rename')}/><MenuItem icon={Pin} label={t(session.pinned?'unpin':'pin')} onClick={()=>onAction('pin')}/><MenuItem icon={session.unread?Eye:EyeOff} label={t(session.unread?'sessionMarkRead':'sessionMarkUnread')} onClick={()=>onAction(session.unread?'read':'unread')}/><MenuItem icon={Folder} label={t('move')} disabled={busy||caps.move===false||Boolean(session.channel)} onClick={()=>onAction('move')}/><MenuDivider/><MenuItem icon={GitFork} label={t('fork')} disabled={busy||caps.fork===false||Boolean(session.channel)} onClick={()=>onAction('fork')}/><MenuItem icon={Copy} label={t('sessionCopyTitle')} onClick={()=>onAction('copyTitle')}/><MenuDivider/>{busy?<MenuItem icon={Square} label={t('stop')} onClick={()=>onAction('interrupt')}/>:null}<MenuItem icon={Archive} label={t(session.archived?'restore':'archive')} disabled={busy} onClick={()=>onAction(session.archived?'restore':'archive')}/></>;
}
