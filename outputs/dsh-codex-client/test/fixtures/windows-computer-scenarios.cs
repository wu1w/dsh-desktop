using System;using System.IO;using System.Drawing;using System.Diagnostics;using System.Runtime.InteropServices;using System.Windows.Forms;using System.Web.Script.Serialization;using System.Collections.Generic;
public class CaptureCanvas:Control {
 public int XOffset=400,YOffset=400,VCount=0,HCount=0,LastDelta=0; public bool ScrollEnabled=true,IsDecoy=false;
 public CaptureCanvas(){DoubleBuffered=true;TabStop=true;Dock=DockStyle.Fill;AccessibleName="DSH controlled scroll viewport";}
 protected override void WndProc(ref Message m){if(m.Msg==0x20A||m.Msg==0x20E){int delta=(short)((m.WParam.ToInt64()>>16)&65535);LastDelta=delta;if(m.Msg==0x20A){VCount++;if(ScrollEnabled)YOffset=Math.Max(0,Math.Min(1000,YOffset-delta/120*60));}else{HCount++;if(ScrollEnabled)XOffset=Math.Max(0,Math.Min(1000,XOffset+delta/120*60));}Invalidate();Update();return;}base.WndProc(ref m);}
 protected override void OnPaint(PaintEventArgs e){var g=e.Graphics;if(IsDecoy){g.Clear(Color.Magenta);g.DrawString("DSH DECOY ONLY",Font,Brushes.Black,30,30);return;}g.Clear(Color.FromArgb(23,151,67));using(var red=new SolidBrush(Color.FromArgb(222,31,47)))g.FillRectangle(red,15,15,70,70);using(var blue=new SolidBrush(Color.FromArgb(33,72,221)))g.FillRectangle(blue,Width-90,15,70,70);using(var yellow=new SolidBrush(Color.FromArgb(239,205,31)))g.FillRectangle(yellow,15,Height-90,70,70);using(var dynamicColor=new SolidBrush(Color.FromArgb(50+XOffset/10,40+YOffset/10,123)))g.FillRectangle(dynamicColor,Width/2-55,Height/2-55,110,110);g.DrawString("DSH TARGET ONLY  X="+XOffset+" Y="+YOffset,Font,Brushes.White,105,25);}
}
public static class ScenarioFixture {
 [StructLayout(LayoutKind.Sequential)]struct RECT{public int Left,Top,Right,Bottom;}
 [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")]static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")]static extern bool IsWindowEnabled(IntPtr h);
 [DllImport("dwmapi.dll")]static extern int DwmGetWindowAttribute(IntPtr h,uint a,out RECT r,int size);
 [DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr h,out RECT r);
 static object Bounds(IntPtr h){RECT r;if(DwmGetWindowAttribute(h,9,out r,Marshal.SizeOf(typeof(RECT)))!=0)GetWindowRect(h,out r);return new{x=r.Left,y=r.Top,width=r.Right-r.Left,height=r.Bottom-r.Top};}
 [STAThread]public static void Main(string[] args){Application.EnableVisualStyles();string dir=args[0];var json=new JavaScriptSerializer();var a=new Form{Text="DSH screenshot-scroll target",StartPosition=FormStartPosition.Manual,Left=240,Top=170,Width=640,Height=420};var canvas=new CaptureCanvas();a.Controls.Add(canvas);var b=new Form{Text="DSH screenshot-scroll occluder",StartPosition=FormStartPosition.Manual,Left=650,Top=210,Width=240,Height=300,BackColor=Color.Magenta};var other=new CaptureCanvas{IsDecoy=true};b.Controls.Add(other);other.BackColor=Color.Magenta;int motion=0;long applied=0;IntPtr handle=IntPtr.Zero;bool activation=false;var timer=new Timer{Interval=60};
 Action snapshot=()=>{var fg=GetForegroundWindow();var displays=new List<object>();foreach(var screen in Screen.AllScreens)displays.Add(new{x=screen.Bounds.X,y=screen.Bounds.Y,width=screen.Bounds.Width,height=screen.Bounds.Height,primary=screen.Primary});var state=new{pid=Process.GetCurrentProcess().Id,session=Process.GetCurrentProcess().SessionId,target=handle.ToInt64().ToString(),decoy=b.IsDisposed?"0":b.Handle.ToInt64().ToString(),foreground=fg.ToInt64().ToString(),targetEnabled=!a.IsDisposed&&IsWindowEnabled(handle),targetClosed=a.IsDisposed,minimized=!a.IsDisposed&&a.WindowState==FormWindowState.Minimized,activationReturned=activation,bounds=Bounds(handle),markerRed=canvas.IsDisposed?Point.Empty:canvas.PointToScreen(new Point(50,50)),markerBlue=canvas.IsDisposed?Point.Empty:canvas.PointToScreen(new Point(canvas.Width-55,50)),markerYellow=canvas.IsDisposed?Point.Empty:canvas.PointToScreen(new Point(50,canvas.Height-55)),x=canvas.XOffset,y=canvas.YOffset,vCount=canvas.VCount,hCount=canvas.HCount,lastDelta=canvas.LastDelta,scrollEnabled=canvas.ScrollEnabled,decoyX=other.XOffset,decoyY=other.YOffset,decoyV=other.VCount,decoyH=other.HCount,applied,displays};File.WriteAllText(Path.Combine(dir,"state.json"),json.Serialize(state));};
 timer.Tick+=(sender,e)=>{try{var file=Path.Combine(dir,"command.json");if(File.Exists(file)){var c=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(file));long id=Convert.ToInt64(c["id"]);if(id>applied){applied=id;string action=Convert.ToString(c["action"]);
 if(action=="activate"){a.WindowState=FormWindowState.Normal;a.Show();a.Activate();canvas.Focus();activation=SetForegroundWindow(handle);}
 if(action=="cover"){b.SetBounds(a.Left+a.Width/2,a.Top+55,a.Width/2,270);b.Show();b.BringToFront();b.Activate();}
 if(action=="uncover"){b.Hide();a.Activate();canvas.Focus();activation=SetForegroundWindow(handle);}
 if(action=="animate")motion=20;
 if(action=="stop-animation")motion=0;
 if(action=="move")a.Location=new Point(a.Left+75,a.Top+40);
 if(action=="resize")a.Size=new Size(760,480);
 if(action=="minimize")a.WindowState=FormWindowState.Minimized;
 if(action=="modal"){b.Hide();a.BeginInvoke((Action)(()=>b.ShowDialog(a)));}
 if(action=="dismiss"){b.Hide();a.Activate();canvas.Focus();activation=SetForegroundWindow(handle);}
 if(action=="offset"){canvas.XOffset=Convert.ToInt32(c["x"]);canvas.YOffset=Convert.ToInt32(c["y"]);canvas.ScrollEnabled=!c.ContainsKey("enabled")||Convert.ToBoolean(c["enabled"]);canvas.Invalidate();canvas.Update();}
 if(action=="close-target")a.Close();
 if(action=="quit"){timer.Stop();b.Close();if(!a.IsDisposed)a.Close();Application.ExitThread();return;}
 }}if(motion>0&&!a.IsDisposed){a.Left+=2;motion--;}snapshot();}catch(Exception error){File.WriteAllText(Path.Combine(dir,"fixture-error.txt"),error.ToString());}};
 a.Show();handle=a.Handle;canvas.Focus();snapshot();timer.Start();Application.Run(new ApplicationContext());
 }
}