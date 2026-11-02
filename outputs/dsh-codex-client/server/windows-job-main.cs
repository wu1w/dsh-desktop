using System;
using System.IO;
using System.Text;
namespace Dsh {
 public static class JobMain {
  public static int Main(string[] args) {
   // Ctrl-C belongs to the child command, not to the Job lease owner.
   // Windows broadcasts it to the shared console; keep this guard alive.
   Console.CancelKeyPress += delegate(object sender, ConsoleCancelEventArgs e) { e.Cancel=true; };
   try {
    int host;Guid id;
    if(args.Length<3||!Int32.TryParse(args[0],out host)||host<=1||!args[1].StartsWith("Local\\DSH-")||!Guid.TryParse(args[1].Substring(10),out id)||!Path.IsPathRooted(args[2]))throw new ArgumentException();
    var childArgs=new string[args.Length-3];Array.Copy(args,3,childArgs,0,childArgs.Length);
    return WindowsJob.Run(args[2],childArgs,host,args[1]);
   } catch {Console.Error.WriteLine("DSH_WINDOWS_JOB_FAILED");return 125;}
  }
 }
}
