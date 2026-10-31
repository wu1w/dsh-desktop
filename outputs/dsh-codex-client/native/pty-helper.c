#define _DARWIN_C_SOURCE
#include <sys/types.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <sys/resource.h>
#include <sys/proc.h>
#include <util.h>
#include <libproc.h>
#include <signal.h>
#include <poll.h>
#include <termios.h>
#include <unistd.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <time.h>

/* A separate guardian holds no host input/output or PTY fd. Its private pipe
 * reaches EOF even if the helper is killed. It retains only stderr to report
 * completed cleanup before Node observes the helper's final close event. */
static volatile sig_atomic_t stopping = 0;
static void stop_signal(int signal_number) { (void)signal_number; stopping = 1; }
static uint32_t be32(const unsigned char *p) { return ((uint32_t)p[0]<<24)|((uint32_t)p[1]<<16)|((uint32_t)p[2]<<8)|p[3]; }
static long long milliseconds(void) { struct timespec now;clock_gettime(CLOCK_MONOTONIC,&now);return (long long)now.tv_sec*1000+now.tv_nsec/1000000; }
static int same_process(pid_t pid, const struct proc_bsdinfo *identity) {
  struct proc_bsdinfo current;
  return proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&current,sizeof(current))==(int)sizeof(current)
    && current.pbi_start_tvsec==identity->pbi_start_tvsec && current.pbi_start_tvusec==identity->pbi_start_tvusec;
}
static void cleanup_session(pid_t session, int signal_number) {
  pid_t pids[32768];
  int bytes = proc_listpids(PROC_ALL_PIDS, 0, pids, sizeof(pids));
  int count = bytes > 0 ? bytes / (int)sizeof(pid_t) : 0;
  for (int i=0; i<count; i++) {
    pid_t pid = pids[i];
    if (pid > 1 && pid != getpid() && getsid(pid) == session) kill(pid, signal_number);
  }
}
static int session_has_live_process(pid_t session) {
  pid_t pids[32768];
  int bytes=proc_listpids(PROC_ALL_PIDS,0,pids,sizeof(pids));
  if(bytes<=0 || bytes>=(int)sizeof(pids))return 1;
  for(int i=0;i<bytes/(int)sizeof(pid_t);i++) {
    pid_t pid=pids[i];
    if(pid>1 && pid!=getpid() && getsid(pid)==session) {
      struct proc_bsdinfo info;
      if(proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&info,sizeof(info))==(int)sizeof(info)) {
        if(info.pbi_status!=SZOMB)return 1;
      } else if(kill(pid,0)==0 || errno!=ESRCH)return 1;
    }
  }
  return 0;
}
static void guard_session(int reader, int writer, int master, int start_writer, pid_t session) {
  struct proc_bsdinfo identity;
  int known=proc_pidinfo(session,PROC_PIDTBSDINFO,0,&identity,sizeof(identity))==(int)sizeof(identity);
  close(writer); close(start_writer);close(master); close(STDIN_FILENO); close(STDOUT_FILENO);
  (void)setsid();
  signal(SIGTERM, SIG_IGN); signal(SIGHUP, SIG_IGN); signal(SIGINT, SIG_IGN); signal(SIGPIPE, SIG_IGN);
  char byte;
  while (read(reader, &byte, 1) < 0 && errno == EINTR) {}
  close(reader);
  /* Freeze leaders first, then kill every process in the PTY session rather
   * than only the shell's original group. Re-scan catches job-control groups. */
  cleanup_session(session, SIGSTOP);
  if(known && same_process(session,&identity))kill(session,SIGSTOP);
  cleanup_session(session, SIGTERM);
  if(known && same_process(session,&identity))kill(session,SIGTERM);
  cleanup_session(session, SIGCONT);
  if(known && same_process(session,&identity))kill(session,SIGCONT);
  usleep(150000);
  for (int i=0; i<8; i++) { cleanup_session(session, SIGKILL); if(known && same_process(session,&identity))kill(session,SIGKILL);usleep(25000); }
  long long deadline=milliseconds()+1000;
  while(session_has_live_process(session)) {
    if(milliseconds()>=deadline) { fputs("DSH_PTY_GUARD_FAILED\n",stderr);_exit(125); }
    cleanup_session(session,SIGKILL);usleep(25000);
  }
  fprintf(stderr,"DSH_PTY_GUARD_DONE %d %d\n",(int)getpid(),(int)session);
  _exit(0);
}
static int flush_bytes(int fd, unsigned char *buffer, size_t *length) {
  if (!*length) return 0;
  ssize_t written = write(fd, buffer, *length);
  if (written > 0) { memmove(buffer, buffer+written, *length-(size_t)written); *length -= (size_t)written; return 0; }
  return written < 0 && (errno==EAGAIN || errno==EINTR) ? 0 : -1;
}
int main(int argc, char **argv) {
  if (argc != 5) { fputs("DSH_PTY_ARGUMENT\n", stderr); return 125; }
  long cols = strtol(argv[2], NULL, 10), rows = strtol(argv[3], NULL, 10);
  if (cols<2 || cols>500 || rows<2 || rows>300 || chdir(argv[1])<0) { fputs("DSH_PTY_ARGUMENT\n", stderr); return 125; }
  const char *shell = argv[4];
  if (strcmp(shell,"/bin/zsh") && strcmp(shell,"/bin/bash")) return 125;
  struct winsize size = {.ws_row=(unsigned short)rows,.ws_col=(unsigned short)cols};
  int start_gate[2];
  if(pipe(start_gate)<0)return 125;
  int master = -1;
  pid_t child = forkpty(&master, NULL, NULL, &size);
  if (child < 0) { fputs("DSH_PTY_FORK\n", stderr); return 125; }
  if (!child) {
    close(start_gate[1]);char ready;
    ssize_t gate;do{gate=read(start_gate[0],&ready,1);}while(gate<0&&errno==EINTR);
    close(start_gate[0]);if(gate!=1)_exit(125);
    struct rlimit files = {256,256}; (void)setrlimit(RLIMIT_NOFILE,&files);
    struct rlimit cores = {0,0}; (void)setrlimit(RLIMIT_CORE,&cores);
    signal(SIGPIPE,SIG_DFL);
    if (!strcmp(shell,"/bin/zsh")) execl(shell,"zsh","-f","-i",(char *)NULL);
    else execl(shell,"bash","--noprofile","--norc","-i",(char *)NULL);
    _exit(127);
  }
  close(start_gate[0]);
  int guardian_pipe[2];
  if (pipe(guardian_pipe)<0) { cleanup_session(child,SIGKILL); return 125; }
  pid_t guardian = fork();
  if (!guardian) guard_session(guardian_pipe[0],guardian_pipe[1],master,start_gate[1],child);
  close(guardian_pipe[0]);
  if (guardian<0) { close(guardian_pipe[1]); cleanup_session(child,SIGKILL); return 125; }
  if(write(start_gate[1],"1",1)!=1)stopping=1;close(start_gate[1]);
  signal(SIGPIPE,SIG_IGN); signal(SIGTERM,stop_signal); signal(SIGHUP,stop_signal); signal(SIGINT,stop_signal);
  fcntl(master,F_SETFL,fcntl(master,F_GETFL)|O_NONBLOCK);
  fcntl(STDOUT_FILENO,F_SETFL,fcntl(STDOUT_FILENO,F_GETFL)|O_NONBLOCK);
  unsigned char input[131072], to_pty[131072], output[262144];
  size_t input_length=0, pty_length=0, output_length=0;
  int child_status=0, child_exited=0,pty_done=0;long long drain_deadline=0;
  while (!stopping) {
    pid_t reaped = waitpid(child,&child_status,WNOHANG);
    if (reaped==child) { child_exited=1;drain_deadline=milliseconds()+2000;close(guardian_pipe[1]);guardian_pipe[1]=-1; }
    if(child_exited && milliseconds()>=drain_deadline){if(!pty_done||output_length)fputs("DSH_PTY_OUTPUT_TRUNCATED\n",stderr);break;}
    struct pollfd fds[3] = {
      {.fd=STDIN_FILENO,.events=(input_length<sizeof(input)-65541 && pty_length<65536)?POLLIN:0},
      {.fd=pty_done?-1:master,.events=(output_length<sizeof(output)-65536?POLLIN:0)|(pty_length?POLLOUT:0)},
      {.fd=STDOUT_FILENO,.events=output_length?POLLOUT:0}
    };
    if (poll(fds,3,child_exited?10:100)<0) { if(errno==EINTR) continue; break; }
    if (fds[2].revents&POLLOUT) if(flush_bytes(STDOUT_FILENO,output,&output_length)<0) break;
    if (fds[2].revents&(POLLERR|POLLHUP|POLLNVAL)) break;
    if (fds[1].revents&POLLOUT) if(flush_bytes(master,to_pty,&pty_length)<0) break;
    if (fds[1].revents&POLLIN) {
      ssize_t count=read(master,output+output_length,sizeof(output)-output_length);
      if(count>0) output_length+=(size_t)count;
      else if(count==0 || (count<0 && errno!=EAGAIN && errno!=EINTR)) pty_done=1;
    }
    if (fds[0].revents&POLLIN) {
      ssize_t count=read(STDIN_FILENO,input+input_length,sizeof(input)-input_length);
      if(count<=0) break;
      input_length+=(size_t)count;
      while(input_length>=5) {
        uint32_t length=be32(input+1);
        if(length>65536) { stopping=1; break; }
        if(input_length<5+(size_t)length) break;
        if(input[0]==1 && pty_length+length<=sizeof(to_pty)) { memcpy(to_pty+pty_length,input+5,length); pty_length+=length; }
        else if(input[0]==2 && length==8) {
          uint32_t c=be32(input+5),r=be32(input+9);
          if(c<2 || c>500 || r<2 || r>300) { stopping=1; break; }
          size.ws_col=(unsigned short)c;size.ws_row=(unsigned short)r;
          if(ioctl(master,TIOCSWINSZ,&size)<0) { stopping=1; break; }
        } else if(input[0]==3 && length==0) { stopping=1; break; }
        else { stopping=1; break; }
        memmove(input,input+5+length,input_length-5-length); input_length-=5+length;
      }
    }
    if(fds[0].revents&(POLLHUP|POLLERR|POLLNVAL)) break;
    if((fds[1].revents&(POLLHUP|POLLERR)) && !(fds[1].revents&POLLIN))pty_done=1;
    if(pty_done&&!output_length)break;
  }
  close(master); if(guardian_pipe[1]>=0)close(guardian_pipe[1]);
  long long flush_deadline=milliseconds()+1000;
  while(output_length&&milliseconds()<flush_deadline){struct pollfd writer={.fd=STDOUT_FILENO,.events=POLLOUT};if(poll(&writer,1,20)>0&&(writer.revents&POLLOUT)){if(flush_bytes(STDOUT_FILENO,output,&output_length)<0)break;}}
  if(output_length)fputs("DSH_PTY_OUTPUT_TRUNCATED\n",stderr);
  int guardian_status=0;pid_t guardian_result;
  do{guardian_result=waitpid(guardian,&guardian_status,0);}while(guardian_result<0 && errno==EINTR);
  if(!child_exited) {
    /* A not-yet-reaped direct child cannot have its PID reused. This also
     * covers immediate EOF before forkpty's child has established its SID. */
    kill(child,SIGKILL);
    long long deadline=milliseconds()+1000;
    while(milliseconds()<deadline) { pid_t result=waitpid(child,&child_status,WNOHANG);if(result==child||result<0)break;usleep(10000); }
  }
  int code=WIFEXITED(child_status)?WEXITSTATUS(child_status):0;
  int sig=WIFSIGNALED(child_status)?WTERMSIG(child_status):0;
  if(guardian_result!=guardian || !WIFEXITED(guardian_status) || WEXITSTATUS(guardian_status)!=0) {
    fputs("DSH_PTY_GUARD_FAILED\n",stderr);return 125;
  }
  fprintf(stderr,"DSH_PTY_EXIT %d %d\n",code,sig);
  return code;
}
