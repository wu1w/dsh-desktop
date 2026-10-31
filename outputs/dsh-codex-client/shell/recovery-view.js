export function renderRecovery({document,container,recovery,t,locale='zh-CN',act,problem=''}){
  const panel=document.createElement('section');panel.className='core-panel core-recovery';
  const text=(tag,value)=>{const element=document.createElement(tag);element.textContent=value;return element;};
  const buttons=[];let busy=false,confirmation;
  const action=(label,work)=>{const button=document.createElement('button');button.type='button';button.textContent=label;button.onclick=()=>{if(!busy)void work();};buttons.push(button);return button;};
  const send=async body=>{if(busy)return;busy=true;for(const button of buttons)button.disabled=true;try{await act(body);}finally{busy=false;for(const button of buttons)button.disabled=false;}};
  const confirm=(body,description)=>{
    confirmation?.remove();confirmation=document.createElement('div');confirmation.className='core-recovery-confirm';confirmation.setAttribute('role','group');confirmation.setAttribute('aria-label',t('recoveryConfirm'));
    confirmation.append(text('p',description),action(t('recoveryCancel'),()=>{confirmation.remove();confirmation=null;}),action(t('recoveryConfirm'),()=>send(body)));panel.append(confirmation);confirmation.querySelector('button')?.focus();
  };
  panel.append(text('h1',t('recoveryTitle')),text('p',t('recoveryDescription')));
  const reason=t(recovery.code);if(reason!==recovery.code)panel.append(text('p',reason));
  if(problem){const alert=text('p',problem);alert.setAttribute('role','alert');panel.append(alert);}
  panel.append(text('h2',t('recoveryAvailable')));
  const candidates=Array.isArray(recovery.candidates)?recovery.candidates:[];
  if(!candidates.length)panel.append(text('p',t('recoveryNoBackup')));
  for(const candidate of candidates){
    const row=document.createElement('div');row.className='core-plugin';const label=document.createElement('div');
    const date=new Date(candidate.createdAt);const formatted=Number.isNaN(date.getTime())?t('recoveryUnknownDate'):new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'short'}).format(date);
    const number=value=>new Intl.NumberFormat(locale).format(Number.isSafeInteger(value)?value:0);
    label.append(text('strong',t('recoveryLastGood')),text('small',formatted),text('small',t('recoveryCounts').replace('{projects}',number(candidate.projects)).replace('{sessions}',number(candidate.sessions))));
    row.append(label);if(recovery.canReset)row.append(action(t('recoveryRestore'),()=>confirm({action:'restore',candidateId:candidate.id},t('recoveryRestoreConfirm'))));panel.append(row);
  }
  const actions=document.createElement('div');actions.className='core-recovery-actions';actions.append(action(t('recoveryRetry'),()=>send({action:'retry'})));
  if(recovery.canReset)actions.append(action(t('recoveryReset'),()=>confirm({action:'reset'},t('recoveryResetConfirm'))));
  else panel.append(text('p',t('recoveryUnsafeHelp')));
  panel.append(actions);container.append(panel);return panel;
}
