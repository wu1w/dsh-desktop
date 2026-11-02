using System;using System.IO;using System.Diagnostics;using System.Runtime.InteropServices;using System.Text;using System.Windows.Forms;using System.Web.Script.Serialization;
public static class FocusFixture {
 [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")]static extern bool IsWindowEnabled(IntPtr window);
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll")]static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")]static extern IntPtr GetAncestor(IntPtr h,uint flags);
 [StructLayout(LayoutKind.Sequential)]struct POINT{public int X,Y;}
 [DllImport("user32.dll")]static extern IntPtr WindowFromPoint(POINT p);
 [DllImport("kernel32.dll")]static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr p);
 [DllImport("advapi32.dll")]static extern bool OpenProcessToken(IntPtr p,uint access,out IntPtr token);
 [DllImport("advapi32.dll")]static extern bool GetTokenInformation(IntPtr t,int c,IntPtr data,int n,out int size);
 [DllImport("advapi32.dll")]static extern IntPtr GetSidSubAuthorityCount(IntPtr s);
 [DllImport("advapi32.dll")]static extern IntPtr GetSidSubAuthority(IntPtr s,uint n);
 static int Integrity(int pid){IntPtr p=OpenProcess(0x1000,false,pid),t=IntPtr.Zero,d=IntPtr.Zero;try{if(p==IntPtr.Zero||!OpenProcessToken(p,8,out t))return -1;int size;GetTokenInformation(t,25,IntPtr.Zero,0,out size);d=Marshal.AllocHGlobal(size);if(!GetTokenInformation(t,25,d,size,out size))return -1;IntPtr sid=Marshal.ReadIntPtr(d);byte count=Marshal.ReadByte(GetSidSubAuthorityCount(sid));return Marshal.ReadInt32(GetSidSubAuthority(sid,(uint)(count-1)));}finally{if(d!=IntPtr.Zero)Marshal.FreeHGlobal(d);if(t!=IntPtr.Zero)CloseHandle(t);if(p!=IntPtr.Zero)CloseHandle(p);}}
 [STAThread] public static void Main(string[] args){Run(args[0]);}
 public static void Run(string directory){
  Application.EnableVisualStyles();var json=new JavaScriptSerializer();var a=new Form{Text="DSH production helper fixture A",Width=640,Height=330,StartPosition=FormStartPosition.Manual,Left=380,Top=210};
  var label=new Label{Text="Disposable test window. Harmless input only.",Left=35,Top=30,AutoSize=true};
  var input=new TextBox{AccessibleName="DSH harmless fixture input",Name="HarmlessFixtureInput",Left=35,Top=85,Width=480};a.Controls.Add(label);a.Controls.Add(input);
  Form b=null;TextBox decoy=null;long last=0;bool activation=false;int helperPid=0;var timer=new Timer{Interval=75};
  Action snapshot=()=>{var fg=GetForegroundWindow();uint fgPid;GetWindowThreadProcessId(fg,out fgPid);var center=input.PointToScreen(new System.Drawing.Point(input.Width/2,input.Height/2));var hit=GetAncestor(WindowFromPoint(new POINT{X=center.X,Y=center.Y}),2);
   var state=new{pid=Process.GetCurrentProcess().Id,session=Process.GetCurrentProcess().SessionId,integrity=Integrity(Process.GetCurrentProcess().Id),helperSession=helperPid>0?Process.GetProcessById(helperPid).SessionId:-1,helperIntegrity=helperPid>0?Integrity(helperPid):-1,target=a.Handle.ToInt64().ToString(),decoy=b==null?"0":b.Handle.ToInt64().ToString(),foreground=fg.ToInt64().ToString(),foregroundPid=fgPid,foregroundIsTarget=fg==a.Handle,foregroundIsDecoy=b!=null&&fg==b.Handle,pointRoot=hit.ToInt64().ToString(),targetEnabled=IsWindowEnabled(a.Handle),activationReturned=activation,targetText=input.Text,decoyText=decoy==null?"":decoy.Text,applied=last,utc=DateTime.UtcNow.ToString("O")};
   File.WriteAllText(Path.Combine(directory,"state.json"),json.Serialize(state));};
  timer.Tick+=(sender,e)=>{try{var command=Path.Combine(directory,"command.json");if(File.Exists(command)){var c=json.Deserialize<System.Collections.Generic.Dictionary<string,object>>(File.ReadAllText(command));long id=Convert.ToInt64(c["id"]);if(id>last){last=id;string action=Convert.ToString(c["action"]);if(c.ContainsKey("helperPid"))helperPid=Convert.ToInt32(c["helperPid"]);
   if(action=="activate"){a.Show();a.BringToFront();a.Activate();input.Focus();activation=SetForegroundWindow(a.Handle);}
   if(action=="modal"){b=new Form{Text="DSH production helper fixture B modal",Width=440,Height=200,StartPosition=FormStartPosition.Manual,Left=460,Top=270};decoy=new TextBox{Text="DECOY_UNCHANGED",AccessibleName="DSH decoy fixture input",Left=25,Top=40,Width=360};b.Controls.Add(decoy);a.BeginInvoke((Action)(()=>b.ShowDialog(a)));}
   if(action=="dismiss-modal"){if(b!=null){b.Close();b=null;decoy=null;}a.Activate();input.Focus();activation=SetForegroundWindow(a.Handle);}
   if(action=="close"){if(b!=null)b.Close();a.Close();return;}
  }}snapshot();}catch(Exception error){File.WriteAllText(Path.Combine(directory,"fixture-error.txt"),error.ToString());}};
  a.Shown+=(sender,e)=>{input.Focus();snapshot();timer.Start();};a.FormClosed+=(sender,e)=>timer.Stop();Application.Run(a);
 }
}