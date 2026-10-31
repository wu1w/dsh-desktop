const known=new Set(['running','waiting','interrupted','failed','uncertain','completed']);
export function runStatus(session,running=session?.running){
  const recovery=session?.runRecovery;
  // Durable recovery owns the run state; a cached transcript may predate it.
  return known.has(recovery?.status)?recovery.status:running?'running':'completed';
}
export function runStatusKey(session,running){return {running:'running',waiting:'taskRecoveryWaiting',interrupted:'interrupted',failed:'failed',uncertain:'taskRecoveryUncertain',completed:'completed'}[runStatus(session,running)];}
export function canStopRun(session,running){return ['running','waiting'].includes(runStatus(session,running));}
export function canResumeRun(session){return Boolean(session?.runRecovery?.canResume)&&['interrupted','failed','uncertain'].includes(runStatus(session));}
