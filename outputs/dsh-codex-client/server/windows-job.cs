// Windows-only owned process launcher. A non-inheritable Job handle belongs to
// this supervisor: normal exit, taskkill, or host shutdown closes it and kills
// descendants, including descendants that created a separate console.
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
namespace Dsh {
  public static class WindowsJob {
    [StructLayout(LayoutKind.Sequential)] struct STARTUPINFO {
      public uint cb; public string lpReserved, lpDesktop, lpTitle;
      public uint dwX,dwY,dwXSize,dwYSize,dwXCountChars,dwYCountChars,dwFillAttribute,dwFlags;
      public ushort wShowWindow,cbReserved2; public IntPtr lpReserved2,hStdInput,hStdOutput,hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process,thread; public uint pid,tid; }
    [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
      public long processTime,jobTime; public uint flags; public UIntPtr minWorkingSet,maxWorkingSet;
      public uint activeProcessLimit; public UIntPtr affinity; public uint priority,scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT {
      public BASIC_LIMIT basic; public IO_COUNTERS io; public UIntPtr processMemory,jobMemory,peakProcessMemory,peakJobMemory;
    }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,ref EXTENDED_LIMIT limits,uint length);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr processAttrs,IntPtr threadAttrs,bool inherit,uint flags,IntPtr environment,string cwd,ref STARTUPINFO startup,out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForMultipleObjects(uint count,IntPtr[] handles,bool all,uint milliseconds);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
    static void Check(bool ok) { if(!ok)throw new Win32Exception(Marshal.GetLastWin32Error()); }
    // CommandLineToArgvW escaping, including trailing backslashes and quotes.
    static string Quote(string value) {
      StringBuilder result=new StringBuilder("\""); int slashes=0;
      foreach(char c in value) {
        if(c=='\\'){slashes++;continue;}
        if(c=='"'){result.Append('\\',slashes*2+1);result.Append(c);}
        else{result.Append('\\',slashes);result.Append(c);} slashes=0;
      }
      result.Append('\\',slashes*2);return result.Append('"').ToString();
    }
    public static int Run(string executable,string[] args,int hostPid) {
      IntPtr job=IntPtr.Zero,host=IntPtr.Zero; PROCESS_INFORMATION process=new PROCESS_INFORMATION();
      try {
        // Keep a kernel handle to the launching host, not a polling PID.
        // Failure/host death before process creation fails closed.
        host=OpenProcess(0x100000,false,checked((uint)hostPid));Check(host!=IntPtr.Zero);
        if(WaitForSingleObject(host,0)!=258)return 125;
        job=CreateJobObject(IntPtr.Zero,null);Check(job!=IntPtr.Zero);
        EXTENDED_LIMIT limits=new EXTENDED_LIMIT();limits.basic.flags=0x2000; // KILL_ON_JOB_CLOSE
        Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT))));
        STARTUPINFO startup=new STARTUPINFO();startup.cb=(uint)Marshal.SizeOf(typeof(STARTUPINFO));
        startup.dwFlags=0x100;startup.hStdInput=GetStdHandle(-10);startup.hStdOutput=GetStdHandle(-11);startup.hStdError=GetStdHandle(-12);
        StringBuilder command=new StringBuilder(Quote(executable));foreach(string arg in args)command.Append(' ').Append(Quote(arg));
        Check(CreateProcess(executable,command,IntPtr.Zero,IntPtr.Zero,true,4,IntPtr.Zero,null,ref startup,out process));
        // No user code can run before its process belongs to our Job.
        Check(AssignProcessToJobObject(job,process.process));if(WaitForSingleObject(host,0)!=258)return 125;Check(ResumeThread(process.thread)!=0xffffffff);
        uint ended=WaitForMultipleObjects(2,new IntPtr[]{process.process,host},false,0xffffffff);
        if(ended==1)return 125;Check(ended==0);uint code;Check(GetExitCodeProcess(process.process,out code));return unchecked((int)code);
      } finally {
        // If assignment/resume failed, the suspended child must not survive.
        if(process.process!=IntPtr.Zero){TerminateProcess(process.process,125);CloseHandle(process.process);}
        if(process.thread!=IntPtr.Zero)CloseHandle(process.thread);
        if(job!=IntPtr.Zero)CloseHandle(job);
        if(host!=IntPtr.Zero)CloseHandle(host);
      }
    }
  }
}
