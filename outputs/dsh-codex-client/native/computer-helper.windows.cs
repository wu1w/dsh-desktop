using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Automation;

// Windows UI Automation, bound to one observed process and top-level window.
// Standard-user only: UIPI/protected desktop failures are surfaced, never bypassed.
namespace DshComputer {
 public sealed class AdapterFailure : Exception { public readonly string Code; public AdapterFailure(string code) { Code=code; } }
 public static class WindowsAdapter {
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left,Top,Right,Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X,Y; }
  [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int Size; public RECT Monitor,Work; public uint Flags; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int X,Y; public uint Data,Flags,Time; public UIntPtr Extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort Key,Scan; public uint Flags,Time; public UIntPtr Extra; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT Mouse; [FieldOffset(0)] public KEYBDINPUT Key; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint Type; public INPUTUNION Data; }
  delegate bool EnumWindow(IntPtr window,IntPtr arg);
  delegate bool EnumMonitor(IntPtr monitor,IntPtr dc,ref RECT rect,IntPtr arg);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindow callback,IntPtr arg);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window,uint flags);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window,StringBuilder text,int max);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window,out RECT rect);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window,uint attr,out RECT rect,int size);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window,int command);
  [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,INPUT[] input,int size);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr dc,IntPtr clip,EnumMonitor callback,IntPtr arg);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor,ref MONITORINFO info);
  [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr monitor,int type,out uint x,out uint y);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll",SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint thread);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr obj,int index,StringBuilder text,int length,out int needed);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int type,IntPtr data,int size,out int needed);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid,uint index);
  [DllImport("wtsapi32.dll",SetLastError=true)] static extern bool WTSQuerySessionInformation(IntPtr server,int session,int type,out IntPtr data,out int bytes);
  [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr data);
  static readonly JavaScriptSerializer Json=new JavaScriptSerializer { MaxJsonLength=4000000,RecursionLimit=40 };
  static readonly List<AutomationElement> Elements=new List<AutomationElement>();
  static readonly List<string> Signatures=new List<string>();
  static int ObservedPid; static long ObservedStarted; static IntPtr ObservedWindow=IntPtr.Zero; static RECT ObservedBounds; static string Token=""; static bool DpiAware;
  static void Fail(string code) { throw new AdapterFailure(code); }
  static Dictionary<string,object> Obj(params object[] values) { var d=new Dictionary<string,object>();for(int i=0;i<values.Length;i+=2)d[(string)values[i]]=values[i+1];return d; }
  static string Text(Dictionary<string,object> input,string key) { object value;return input.TryGetValue(key,out value)&&value is string?(string)value:""; }
  static int Integer(Dictionary<string,object> input,string key,int min,int max) { object value; if(!input.TryGetValue(key,out value)||!(value is int||value is long||value is double||value is decimal)) {Fail("COMPUTER_INVALID_INPUT");return 0;}double number=Convert.ToDouble(value,CultureInfo.InvariantCulture);if(Double.IsNaN(number)||Double.IsInfinity(number)||number<min||number>max||number!=Math.Floor(number))Fail("COMPUTER_INVALID_INPUT");return (int)number; }
  static double Number(Dictionary<string,object> input,string key) { object value;if(!input.TryGetValue(key,out value)||!(value is int||value is long||value is double||value is decimal)){Fail("COMPUTER_INVALID_INPUT");return 0;}double n=Convert.ToDouble(value,CultureInfo.InvariantCulture);if(Double.IsNaN(n)||Double.IsInfinity(n))Fail("COMPUTER_INVALID_INPUT");return n; }
  static string Limit(string text,int size) { return String.IsNullOrEmpty(text)?"":text.Substring(0,Math.Min(size,text.Length)); }
  static string DesktopName(IntPtr desktop) {int needed;var text=new StringBuilder(256);return GetUserObjectInformation(desktop,2,text,text.Capacity*2,out needed)?text.ToString():"";}
  static bool InteractiveDesktop() {int session=Process.GetCurrentProcess().SessionId;if(!Environment.UserInteractive||session==0)return false;IntPtr state=IntPtr.Zero;int bytes;try{if(!WTSQuerySessionInformation(IntPtr.Zero,session,8,out state,out bytes)||bytes<4||Marshal.ReadInt32(state)!=0)return false;}finally{if(state!=IntPtr.Zero)WTSFreeMemory(state);}IntPtr input=OpenInputDesktop(0,false,1);if(input==IntPtr.Zero)return false;try{return DesktopName(input)=="Default"&&DesktopName(GetThreadDesktop(GetCurrentThreadId()))=="Default";}finally{CloseDesktop(input);}}
  static int Integrity(int pid) {IntPtr process=OpenProcess(0x1000,false,pid),token=IntPtr.Zero,data=IntPtr.Zero;if(process==IntPtr.Zero){Fail("COMPUTER_INPUT_BLOCKED");return 0;}try{if(!OpenProcessToken(process,8,out token))Fail("COMPUTER_INPUT_BLOCKED");int size;GetTokenInformation(token,25,IntPtr.Zero,0,out size);if(size<=0||size>65536)Fail("COMPUTER_INPUT_BLOCKED");data=Marshal.AllocHGlobal(size);if(!GetTokenInformation(token,25,data,size,out size))Fail("COMPUTER_INPUT_BLOCKED");IntPtr sid=Marshal.ReadIntPtr(data);byte count=Marshal.ReadByte(GetSidSubAuthorityCount(sid));if(count==0)Fail("COMPUTER_INPUT_BLOCKED");return Marshal.ReadInt32(GetSidSubAuthority(sid,(uint)(count-1)));}finally{if(data!=IntPtr.Zero)Marshal.FreeHGlobal(data);if(token!=IntPtr.Zero)CloseHandle(token);CloseHandle(process);}}
  static void TargetAllowed(int pid) {using(var process=Process.GetProcessById(pid)){if(process.SessionId!=Process.GetCurrentProcess().SessionId)Fail("COMPUTER_DESKTOP_UNAVAILABLE");}if(Integrity(pid)>Integrity(Process.GetCurrentProcess().Id))Fail("COMPUTER_INPUT_BLOCKED");}
  static string WindowName(IntPtr window) { var text=new StringBuilder(1024);GetWindowText(window,text,text.Capacity);return text.ToString(); }
  static int Owner(IntPtr window) { uint pid;GetWindowThreadProcessId(window,out pid);return (int)pid; }
  static long Started(int pid) { try {using(var p=Process.GetProcessById(pid))return p.StartTime.ToUniversalTime().Ticks;}catch{Fail("COMPUTER_APP_GONE");return 0;} }
  static RECT Bounds(IntPtr window) { RECT r;if(DwmGetWindowAttribute(window,9,out r,Marshal.SizeOf(typeof(RECT)))!=0&&!GetWindowRect(window,out r))Fail("COMPUTER_NO_WINDOW");if(r.Right<=r.Left||r.Bottom<=r.Top)Fail("COMPUTER_NO_WINDOW");return r; }
  static bool Equal(RECT a,RECT b) { return a.Left==b.Left&&a.Top==b.Top&&a.Right==b.Right&&a.Bottom==b.Bottom; }
  static Dictionary<string,object> RectObject(RECT r) {return Obj("x",r.Left,"y",r.Top,"width",r.Right-r.Left,"height",r.Bottom-r.Top);}
  static List<object> Displays() {var result=new List<object>();EnumDisplayMonitors(IntPtr.Zero,IntPtr.Zero,delegate(IntPtr monitor,IntPtr dc,ref RECT r,IntPtr arg){var info=new MONITORINFO();info.Size=Marshal.SizeOf(typeof(MONITORINFO));if(GetMonitorInfo(monitor,ref info)){uint x=96,y=96;try{if(GetDpiForMonitor(monitor,0,out x,out y)!=0){x=96;y=96;}}catch{}result.Add(Obj("bounds",RectObject(info.Monitor),"scaleFactor",x/96.0,"primary",(info.Flags&1)!=0));}return true;},IntPtr.Zero);return result;}

  static Dictionary<string,object> Apps() {var rows=new List<object>();var seen=new HashSet<int>();EnumWindows(delegate(IntPtr w,IntPtr unused){int pid=Owner(w);if(pid<=0||pid==Process.GetCurrentProcess().Id||!IsWindowVisible(w)||!seen.Add(pid))return true;string title=WindowName(w);if(title.Length==0){seen.Remove(pid);return true;}try{using(var p=Process.GetProcessById(pid))rows.Add(Obj("pid",pid,"name",p.ProcessName,"title",Limit(title,300),"bundleId","","windowId",w.ToInt64().ToString(CultureInfo.InvariantCulture),"processStartTime",p.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture)));}catch{}return rows.Count<300;},IntPtr.Zero);return Obj("apps",rows);}
  static bool Secret(AutomationElement element) {var c=element.Current;if(c.IsPassword)return true;string label=(c.Name+" "+c.AutomationId+" "+c.HelpText).ToLowerInvariant();return System.Text.RegularExpressions.Regex.IsMatch(label,@"password|passcode|one[ -]?time|verification[ _-]?code|security[ _-]?code|(^|[^a-z])otp([^a-z]|$)|密码|验证码|校验码");}
  static string Value(AutomationElement element) {if(Secret(element))return "[protected]";object pattern;if(element.TryGetCurrentPattern(ValuePattern.Pattern,out pattern))return Limit(((ValuePattern)pattern).Current.Value,400);return "";}
  static string ValueFingerprint(AutomationElement element) {if(Secret(element))return "[protected]";object pattern;if(!element.TryGetCurrentPattern(ValuePattern.Pattern,out pattern))return "";using(var hash=System.Security.Cryptography.SHA256.Create())return Convert.ToBase64String(hash.ComputeHash(Encoding.UTF8.GetBytes(((ValuePattern)pattern).Current.Value??"")));}
  static string Signature(AutomationElement element) {var c=element.Current;return String.Join("|",Array.ConvertAll(element.GetRuntimeId(),v=>v.ToString(CultureInfo.InvariantCulture)))+"|"+c.ControlType.Id+"|"+c.Name+"|"+ValueFingerprint(element)+"|"+c.IsEnabled+"|"+c.IsPassword+"|"+c.BoundingRectangle.ToString(CultureInfo.InvariantCulture);}
  static Dictionary<string,object> Observe(int pid,IntPtr preferred) {
   Token="";Elements.Clear();Signatures.Clear();TargetAllowed(pid);long started=Started(pid);IntPtr window=preferred;if(window==IntPtr.Zero)Fail("COMPUTER_APP_GONE");
   if(!IsWindow(window)||Owner(window)!=pid||!IsWindowVisible(window))Fail("COMPUTER_APP_GONE");
   if(IsIconic(window))Fail("COMPUTER_NO_WINDOW");
   var root=AutomationElement.FromHandle(window);if(root==null)Fail("COMPUTER_NO_WINDOW");
   var rows=new List<object>();var stack=new Stack<Tuple<AutomationElement,int>>();stack.Push(Tuple.Create(root,0));int remaining=2000;bool truncated=false;
   while(stack.Count>0&&remaining-->0&&Elements.Count<240){var pair=stack.Pop();var element=pair.Item1;try{var current=element.Current;if(!current.IsOffscreen){bool secret=Secret(element);object pattern;bool editable=!secret&&element.TryGetCurrentPattern(ValuePattern.Pattern,out pattern)&&!((ValuePattern)pattern).Current.IsReadOnly;var actions=new List<string>();if(element.TryGetCurrentPattern(InvokePattern.Pattern,out pattern)||element.TryGetCurrentPattern(SelectionItemPattern.Pattern,out pattern)||element.TryGetCurrentPattern(TogglePattern.Pattern,out pattern))actions.Add("click");if(editable)actions.Add("type");string label=Limit(current.Name,300),value=Value(element);if(label.Length>0||value.Length>0||actions.Count>0){int id=Elements.Count;Elements.Add(element);Signatures.Add(Signature(element));var b=current.BoundingRectangle;rows.Add(Obj("id",id,"role",current.ControlType.ProgrammaticName,"label",label,"value",value,"editable",editable,"protected",secret,"enabled",current.IsEnabled,"actions",actions,"bounds",Obj("x",b.X,"y",b.Y,"width",b.Width,"height",b.Height)));}}
    if(pair.Item2<18){var children=new List<AutomationElement>();var child=TreeWalker.ControlViewWalker.GetFirstChild(element);while(child!=null&&children.Count<250){children.Add(child);child=TreeWalker.ControlViewWalker.GetNextSibling(child);}if(child!=null)truncated=true;for(int i=children.Count-1;i>=0;i--)stack.Push(Tuple.Create(children[i],pair.Item2+1));}
   }catch(ElementNotAvailableException){}catch(InvalidOperationException){} }
   ObservedPid=pid;ObservedStarted=started;ObservedWindow=window;ObservedBounds=Bounds(window);Token=Guid.NewGuid().ToString();uint dpi=GetDpiForWindow(window);
   return Obj("platform","win32","pid",pid,"windowId",window.ToInt64().ToString(CultureInfo.InvariantCulture),"title",Limit(WindowName(window),300),"nativeObservation",Token,"elements",rows,"truncated",truncated||remaining<=0||stack.Count>0,"bounds",RectObject(ObservedBounds),"coordinateSpace","physical-screen-pixels","windowScaleFactor",dpi==0?1:dpi/96.0,"displays",Displays());
  }
  static void Focus() {if(!InteractiveDesktop())Fail("COMPUTER_DESKTOP_UNAVAILABLE");TargetAllowed(ObservedPid);if(!IsWindow(ObservedWindow)||Owner(ObservedWindow)!=ObservedPid||Started(ObservedPid)!=ObservedStarted)Fail("COMPUTER_APP_GONE");if(IsIconic(ObservedWindow))Fail("COMPUTER_OBSERVATION_STALE");if(GetForegroundWindow()!=ObservedWindow){SetForegroundWindow(ObservedWindow);Thread.Sleep(80);}if(GetForegroundWindow()!=ObservedWindow)Fail("COMPUTER_FOCUS_CHANGED");if(!Equal(Bounds(ObservedWindow),ObservedBounds))Fail("COMPUTER_OBSERVATION_STALE");}
  static bool WithinWindow(AutomationElement element) {var root=AutomationElement.FromHandle(ObservedWindow);for(int depth=0;element!=null&&depth<40;depth++,element=TreeWalker.RawViewWalker.GetParent(element))if(Automation.Compare(root,element))return true;return false;}
  static AutomationElement Element(Dictionary<string,object> input) {int id=Integer(input,"element",0,239);if(id>=Elements.Count)Fail("COMPUTER_ELEMENT_STALE");var element=Elements[id];if(Signature(element)!=Signatures[id]||!element.Current.IsEnabled||!WithinWindow(element))Fail("COMPUTER_ELEMENT_STALE");return element;}
  static void Send(INPUT[] events) {
   int size=Marshal.SizeOf(typeof(INPUT));uint sent=SendInput((uint)events.Length,events,size);if(sent==(uint)events.Length)return;
   // An uncertain partial injection is never replayed. Only release keys/buttons
   // this request may have pressed; NoHeldModifiers prevents releasing user modifiers.
   var release=new List<INPUT>();for(int i=0;i<events.Length&&i<sent;i++){if(events[i].Type==1&&(events[i].Data.Key.Flags&2)==0)release.Add(Key(events[i].Data.Key.Key,true));if(events[i].Type==0&&(events[i].Data.Mouse.Flags&2)!=0)release.Add(Mouse(4,0,0,0));}
   release.Reverse();if(release.Count>0)SendInput((uint)release.Count,release.ToArray(),size);Fail("COMPUTER_INPUT_BLOCKED");
  }
  static INPUT Mouse(uint flags,int x,int y,uint data) {return new INPUT{Type=0,Data=new INPUTUNION{Mouse=new MOUSEINPUT{Flags=flags,X=x,Y=y,Data=data}}};}
  static INPUT Key(ushort code,bool up) {return new INPUT{Type=1,Data=new INPUTUNION{Key=new KEYBDINPUT{Key=code,Flags=up?2u:0u}}};}
  static void NoHeldModifiers() {foreach(int key in new[]{0x10,0x11,0x12,0x5b,0x5c})if((GetAsyncKeyState(key)&0x8000)!=0)Fail("COMPUTER_FOCUS_CHANGED");}
  static POINT Point(double x,double y) {if(x<0||y<0||x>=ObservedBounds.Right-ObservedBounds.Left||y>=ObservedBounds.Bottom-ObservedBounds.Top)Fail("COMPUTER_INVALID_INPUT");var point=new POINT{X=ObservedBounds.Left+(int)Math.Floor(x),Y=ObservedBounds.Top+(int)Math.Floor(y)};if(GetAncestor(WindowFromPoint(point),2)!=ObservedWindow)Fail("COMPUTER_FOCUS_CHANGED");return point;}
  static INPUT Move(POINT point) {int left=GetSystemMetrics(76),top=GetSystemMetrics(77),width=GetSystemMetrics(78),height=GetSystemMetrics(79);if(width<=1||height<=1||point.X<left||point.Y<top||point.X>=left+width||point.Y>=top+height)Fail("COMPUTER_INVALID_INPUT");return Mouse(0x0001|0x8000|0x4000,(int)Math.Round((point.X-left)*65535.0/(width-1)),(int)Math.Round((point.Y-top)*65535.0/(height-1)),0);}
  static void Keys(string key) {
   string[] parts=key.Split('+');if(parts.Length==0||parts.Length>4)Fail("COMPUTER_INVALID_INPUT");var modifiers=new List<ushort>();var used=new HashSet<ushort>();for(int i=0;i<parts.Length-1;i++){ushort code;switch(parts[i].ToLowerInvariant()){case "ctrl":case "control":code=0x11;break;case "alt":code=0x12;break;case "shift":code=0x10;break;case "meta":case "super":case "win":code=0x5b;break;default:Fail("COMPUTER_INVALID_INPUT");return;}if(!used.Add(code))Fail("COMPUTER_INVALID_INPUT");modifiers.Add(code);}
   string name=parts[parts.Length-1].ToLowerInvariant();ushort vk;switch(name){case "enter":case "return":vk=13;break;case "tab":vk=9;break;case "escape":vk=27;break;case "backspace":vk=8;break;case "delete":vk=46;break;case "arrowup":case "up":vk=38;break;case "arrowdown":case "down":vk=40;break;case "arrowleft":case "left":vk=37;break;case "arrowright":case "right":vk=39;break;case "home":vk=36;break;case "end":vk=35;break;case "pageup":vk=33;break;case "pagedown":vk=34;break;case "space":vk=32;break;default:if(name.Length!=1||!(name[0]>='a'&&name[0]<='z'||name[0]>='0'&&name[0]<='9')){Fail("COMPUTER_INVALID_INPUT");return;}vk=(ushort)Char.ToUpperInvariant(name[0]);break;}
   // Windows/Alt+Tab shortcuts leave the selected app; do not authorize global control.
   if(modifiers.Contains(0x5b)||modifiers.Contains(0x12)&&(vk==9||vk==27)||modifiers.Contains(0x11)&&modifiers.Contains(0x12)&&vk==46)Fail("COMPUTER_ACTION_UNAVAILABLE");
   NoHeldModifiers();var events=new List<INPUT>();foreach(var modifier in modifiers)events.Add(Key(modifier,false));events.Add(Key(vk,false));events.Add(Key(vk,true));for(int i=modifiers.Count-1;i>=0;i--)events.Add(Key(modifiers[i],true));Send(events.ToArray());
  }
  static Dictionary<string,object> Perform(Dictionary<string,object> input) {
   string action=Text(input,"action");bool interactive=InteractiveDesktop();if(action=="status")return Obj("accessibility",DpiAware&&interactive,"screenRecording",DpiAware&&interactive,"nativeReady",DpiAware&&interactive,"nativeReason",!interactive?"COMPUTER_DESKTOP_UNAVAILABLE":!DpiAware?"COMPUTER_NATIVE_UNAVAILABLE":null,"nativeValidation","pending-windows-device","coordinateSpace","physical-screen-pixels","dpiAware",DpiAware);
   if(!interactive)Fail("COMPUTER_DESKTOP_UNAVAILABLE");if(!DpiAware)Fail("COMPUTER_NATIVE_UNAVAILABLE");if(action=="apps")return Apps();int pid=Integer(input,"pid",1,Int32.MaxValue);
   long handle=0,started=0;if(!Int64.TryParse(Text(input,"windowId"),NumberStyles.None,CultureInfo.InvariantCulture,out handle)||handle<=0||!Int64.TryParse(Text(input,"processStartTime"),NumberStyles.None,CultureInfo.InvariantCulture,out started)||started<=0)Fail("COMPUTER_APP_GONE");
   IntPtr bound=new IntPtr(handle);if(!IsWindow(bound)||Owner(bound)!=pid||Started(pid)!=started)Fail("COMPUTER_APP_GONE");
   if(action=="observe")return Observe(pid,bound);
   if(!new HashSet<string>{"click","type","key","scroll"}.Contains(action))Fail("COMPUTER_INVALID_INPUT");
   if(Token.Length==0||Text(input,"nativeObservation")!=Token||ObservedPid!=pid||ObservedWindow!=bound||ObservedStarted!=started)Fail("COMPUTER_OBSERVATION_STALE");Token="";
   Focus();
   if(action=="click"&&input.ContainsKey("element")){var element=Element(input);if(Secret(element))Fail("COMPUTER_PROTECTED_FIELD");object pattern;if(element.TryGetCurrentPattern(InvokePattern.Pattern,out pattern))((InvokePattern)pattern).Invoke();else if(element.TryGetCurrentPattern(SelectionItemPattern.Pattern,out pattern))((SelectionItemPattern)pattern).Select();else if(element.TryGetCurrentPattern(TogglePattern.Pattern,out pattern))((TogglePattern)pattern).Toggle();else Fail("COMPUTER_ACTION_UNAVAILABLE");}
   else if(action=="type"){var element=Element(input);if(Secret(element))Fail("COMPUTER_PROTECTED_FIELD");string text=Text(input,"text");if(text.Length>20000||text.IndexOf('\0')>=0)Fail("COMPUTER_INVALID_INPUT");object pattern;if(!element.TryGetCurrentPattern(ValuePattern.Pattern,out pattern)||((ValuePattern)pattern).Current.IsReadOnly)Fail("COMPUTER_ACTION_UNAVAILABLE");((ValuePattern)pattern).SetValue(text);}
   else if(action=="key"){var focused=AutomationElement.FocusedElement;if(focused==null||Secret(focused))Fail("COMPUTER_PROTECTED_FIELD");if(focused.Current.ProcessId!=ObservedPid||!WithinWindow(focused))Fail("COMPUTER_FOCUS_CHANGED");Keys(Text(input,"key"));}
   else if(action=="click"){NoHeldModifiers();var point=Point(Number(input,"x"),Number(input,"y"));var element=AutomationElement.FromPoint(new Point(point.X,point.Y));if(element==null||Secret(element))Fail("COMPUTER_PROTECTED_FIELD");if(!WithinWindow(element))Fail("COMPUTER_FOCUS_CHANGED");Send(new[]{Move(point),Mouse(2,0,0,0),Mouse(4,0,0,0)});}
   else if(action=="scroll"){string direction=Text(input,"direction");if(!new HashSet<string>{"up","down","left","right"}.Contains(direction))Fail("COMPUTER_INVALID_INPUT");NoHeldModifiers();var point=Point((ObservedBounds.Right-ObservedBounds.Left)/2.0,(ObservedBounds.Bottom-ObservedBounds.Top)/2.0);bool horizontal=direction=="left"||direction=="right";int delta=(direction=="up"||direction=="right")?360:-360;Send(new[]{Move(point),Mouse(horizontal?0x1000u:0x0800u,0,0,unchecked((uint)delta))});}
   Thread.Sleep(100);return Observe(pid,ObservedWindow);
  }
  public static void Run() {
   if(Thread.CurrentThread.GetApartmentState()!=ApartmentState.MTA)throw new InvalidOperationException("COMPUTER_NATIVE_UNAVAILABLE");
   // Per-monitor v2 uses physical pixels including negative virtual-screen coordinates.
   try{SetProcessDpiAwarenessContext(new IntPtr(-4));DpiAware=SetThreadDpiAwarenessContext(new IntPtr(-4))!=IntPtr.Zero;}catch{DpiAware=false;}
   string line;while((line=Console.ReadLine())!=null){Dictionary<string,object> input=null,result;object id=null;try{if(line.Length>100000)Fail("COMPUTER_INVALID_INPUT");input=Json.Deserialize<Dictionary<string,object>>(line);if(input==null)Fail("COMPUTER_INVALID_INPUT");input.TryGetValue("id",out id);result=Perform(input);result["ok"]=true;}catch(AdapterFailure e){Token="";result=Obj("ok",false,"code",e.Code);}catch(ElementNotAvailableException){Token="";result=Obj("ok",false,"code","COMPUTER_ELEMENT_STALE");}catch(System.ComponentModel.Win32Exception){Token="";result=Obj("ok",false,"code","COMPUTER_INPUT_BLOCKED");}catch(UnauthorizedAccessException){Token="";result=Obj("ok",false,"code","COMPUTER_INPUT_BLOCKED");}catch{Token="";result=Obj("ok",false,"code","COMPUTER_NATIVE_FAILED");}result["id"]=id;Console.WriteLine(Json.Serialize(result));Console.Out.Flush();}
  }
 }
}
