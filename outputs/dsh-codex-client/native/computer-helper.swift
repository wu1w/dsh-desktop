import AppKit
import ApplicationServices

// DSH's own macOS accessibility adapter. Observations and elements never cross app bindings.
struct Failure: Error { let code: String }
func fail(_ code:String) throws -> Never {throw Failure(code:code)}
func attr(_ node:AXUIElement,_ key:String)->CFTypeRef?{var value:CFTypeRef?;return AXUIElementCopyAttributeValue(node,key as CFString,&value) == .success ? value:nil}
func string(_ node:AXUIElement,_ key:String)->String{(attr(node,key) as? String) ?? ""}
func rect(_ node:AXUIElement)->CGRect?{guard let p=attr(node,kAXPositionAttribute),let s=attr(node,kAXSizeAttribute),CFGetTypeID(p)==AXValueGetTypeID(),CFGetTypeID(s)==AXValueGetTypeID() else{return nil};var point=CGPoint.zero;var size=CGSize.zero;AXValueGetValue(p as! AXValue,.cgPoint,&point);AXValueGetValue(s as! AXValue,.cgSize,&size);return CGRect(origin:point,size:size)}
var elements:[AXUIElement]=[];var signatures:[String]=[];var observedPid:pid_t=0;var observedWindow:AXUIElement?;var observedRect:CGRect?;var token=""
func appFor(_ input:[String:Any])throws->NSRunningApplication{guard let value=input["pid"] as? Int,value>0,let app=NSRunningApplication(processIdentifier:pid_t(value)),!app.isTerminated else{try fail("COMPUTER_APP_GONE")};return app}
func observe(_ app:NSRunningApplication)throws->[String:Any]{
 guard AXIsProcessTrusted() else{try fail("COMPUTER_ACCESSIBILITY_REQUIRED")}
 let root=AXUIElementCreateApplication(app.processIdentifier);AXUIElementSetMessagingTimeout(root,2)
 let wins=(attr(root,kAXWindowsAttribute) as? [AXUIElement]) ?? []
 guard let window=(attr(root,kAXFocusedWindowAttribute).map{$0 as! AXUIElement}) ?? wins.first else{try fail("COMPUTER_NO_WINDOW")}
 elements=[];signatures=[];observedPid=app.processIdentifier;observedWindow=window;observedRect=rect(window);token=UUID().uuidString
 var lines:[[String:Any]]=[];var visited=Set<CFHashCode>();var remaining=2000
 func walk(_ node:AXUIElement,_ depth:Int){
  if remaining<=0 || elements.count>=240 || depth>18{return};remaining-=1;let hash=CFHash(node);if visited.contains(hash){return};visited.insert(hash)
  let role=string(node,kAXRoleAttribute);let title=String(string(node,kAXTitleAttribute).prefix(300));let description=String(string(node,kAXDescriptionAttribute).prefix(300))
  let secret=role==kAXTextFieldRole && string(node,kAXSubroleAttribute)==kAXSecureTextFieldSubrole
  let value=secret ? "[protected]":String(string(node,kAXValueAttribute).prefix(400))
  var actions:CFArray?;AXUIElementCopyActionNames(node,&actions)
  var settable:DarwinBoolean=false;AXUIElementIsAttributeSettable(node,kAXValueAttribute as CFString,&settable)
  if !title.isEmpty || !description.isEmpty || !value.isEmpty || settable.boolValue || (actions as? [String] ?? []).contains(kAXPressAction){
   let id=elements.count;elements.append(node);signatures.append([string(node,kAXRoleAttribute),string(node,kAXTitleAttribute),string(node,kAXValueAttribute)].joined(separator:"|"));lines.append(["id":id,"role":role,"label":title.isEmpty ? description:title,"value":value,"editable":settable.boolValue && !secret,"protected":secret,"actions":actions as? [String] ?? []])
  }
  for child in (attr(node,kAXChildrenAttribute) as? [AXUIElement] ?? []){walk(child,depth+1)}
 }
 walk(window,0)
 var result:[String:Any]=["pid":Int(app.processIdentifier),"app":app.localizedName ?? "","bundleId":app.bundleIdentifier ?? "","title":string(window,kAXTitleAttribute),"nativeObservation":token,"elements":lines,"truncated":remaining<=0]
 if let r=observedRect,let windows=CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]]{
  let matches=windows.filter{info in guard info[kCGWindowOwnerPID as String] as? Int == Int(app.processIdentifier),let dict=info[kCGWindowBounds as String] as? [String:Any],let bounds=CGRect(dictionaryRepresentation:dict as CFDictionary) else{return false};return abs(bounds.minX-r.minX)<2 && abs(bounds.minY-r.minY)<2 && abs(bounds.width-r.width)<2 && abs(bounds.height-r.height)<2}
  if matches.count==1{result["windowId"]=matches[0][kCGWindowNumber as String]}
 }
 if let r=observedRect{result["bounds"]=["x":r.origin.x,"y":r.origin.y,"width":r.width,"height":r.height]}
 return result
}
func node(_ input:[String:Any])throws->AXUIElement{guard let id=input["element"] as? Int,id>=0,id<elements.count else{try fail("COMPUTER_ELEMENT_STALE")};let target=elements[id];if signatures[id] != [string(target,kAXRoleAttribute),string(target,kAXTitleAttribute),string(target,kAXValueAttribute)].joined(separator:"|"){try fail("COMPUTER_ELEMENT_STALE")};return target}
func keyEvent(_ code:CGKeyCode,_ flags:CGEventFlags){for down in [true,false]{let event=CGEvent(keyboardEventSource:nil,virtualKey:code,keyDown:down);event?.flags=flags;event?.post(tap:.cghidEventTap)}}
func perform(_ input:[String:Any])throws->[String:Any]{
 let action=input["action"] as? String ?? ""
 if action=="status"{return ["accessibility":AXIsProcessTrusted(),"screenRecording":CGPreflightScreenCaptureAccess()]}
 if action=="requestAccessibility"{_ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String:true] as CFDictionary);return ["accessibility":AXIsProcessTrusted()]}
 if action=="apps"{return ["apps":NSWorkspace.shared.runningApplications.filter{$0.activationPolicy == .regular && $0.processIdentifier != getpid()}.map{["pid":Int($0.processIdentifier),"name":$0.localizedName ?? "","bundleId":$0.bundleIdentifier ?? ""] as [String:Any]}]}
 let app=try appFor(input)
 if action=="observe"{return try observe(app)}
 guard AXIsProcessTrusted() else{try fail("COMPUTER_ACCESSIBILITY_REQUIRED")}
 guard observedPid==app.processIdentifier,input["nativeObservation"] as? String==token,!token.isEmpty else{try fail("COMPUTER_OBSERVATION_STALE")}
 if let window=observedWindow,let previous=observedRect,rect(window) != previous{token="";try fail("COMPUTER_OBSERVATION_STALE")}
 token="" // Mutations consume the observation even if the transport result is lost.
 if action=="click",input["element"] != nil{
  let target=try node(input);guard AXUIElementPerformAction(target,kAXPressAction as CFString) == .success else{try fail("COMPUTER_ACTION_UNAVAILABLE")}
 }else if action=="type",input["element"] != nil{
  let target=try node(input);if string(target,kAXSubroleAttribute)==kAXSecureTextFieldSubrole{try fail("COMPUTER_PROTECTED_FIELD")}
  guard let value=input["text"] as? String,value.utf8.count<=80000 else{try fail("COMPUTER_INVALID_INPUT")}
  guard AXUIElementSetAttributeValue(target,kAXValueAttribute as CFString,value as CFString) == .success else{try fail("COMPUTER_ACTION_UNAVAILABLE")}
 }else{
  guard app.activate(options:[]),let window=observedWindow else{try fail("COMPUTER_APP_GONE")}
  _ = AXUIElementPerformAction(window,kAXRaiseAction as CFString)
  RunLoop.current.run(until:Date(timeIntervalSinceNow:0.1))
  guard NSWorkspace.shared.frontmostApplication?.processIdentifier==app.processIdentifier else{try fail("COMPUTER_FOCUS_CHANGED")}
  if action=="key"{
   let parts=(input["key"] as? String ?? "").lowercased().split(separator:"+").map(String.init)
   var flags:CGEventFlags=[];for part in parts.dropLast(){switch part{case "cmd","meta","super":flags.insert(.maskCommand);case "ctrl","control":flags.insert(.maskControl);case "alt","option":flags.insert(.maskAlternate);case "shift":flags.insert(.maskShift);default:try fail("COMPUTER_INVALID_INPUT")}}
   let codes:[String:CGKeyCode]=["return":36,"enter":36,"tab":48,"escape":53,"backspace":51,"delete":117,"up":126,"down":125,"left":123,"right":124,"space":49,"a":0,"c":8,"v":9,"x":7,"z":6,"f":3,"l":37,"w":13]
   guard let key=parts.last,let code=codes[key] else{try fail("COMPUTER_INVALID_INPUT")};keyEvent(code,flags)
  }else if action=="click"{
   guard let r=observedRect,let x=input["x"] as? Double,let y=input["y"] as? Double,x>=0,y>=0,x<r.width,y<r.height else{try fail("COMPUTER_INVALID_INPUT")}
   let point=CGPoint(x:r.origin.x+x,y:r.origin.y+y)
   CGEvent(mouseEventSource:nil,mouseType:.leftMouseDown,mouseCursorPosition:point,mouseButton:.left)?.post(tap:.cghidEventTap)
   CGEvent(mouseEventSource:nil,mouseType:.leftMouseUp,mouseCursorPosition:point,mouseButton:.left)?.post(tap:.cghidEventTap)
  }else if action=="scroll"{
   let direction=input["direction"] as? String ?? "down";let horizontal=direction=="left" || direction=="right";let amount:Int32=(direction=="up" || direction=="left") ? 400:-400
   if let r=observedRect{CGEvent(mouseEventSource:nil,mouseType:.mouseMoved,mouseCursorPosition:CGPoint(x:r.midX,y:r.midY),mouseButton:.left)?.post(tap:.cghidEventTap)}
   CGEvent(scrollWheelEvent2Source:nil,units:.pixel,wheelCount:2,wheel1:horizontal ? 0:amount,wheel2:horizontal ? amount:0,wheel3:0)?.post(tap:.cghidEventTap)
  }else{try fail("COMPUTER_ACTION_UNAVAILABLE")}
 }
 RunLoop.current.run(until:Date(timeIntervalSinceNow:0.12))
 return try observe(app)
}
let application=NSApplication.shared
application.setActivationPolicy(.accessory)
DispatchQueue.global().async{
 while let line=readLine(){
  DispatchQueue.main.sync{
   var result:[String:Any]=[:];var request:[String:Any]=[:]
   do{request=(try JSONSerialization.jsonObject(with:Data(line.utf8))) as? [String:Any] ?? [:];result=try perform(request);result["ok"]=true}
   catch let error as Failure{result=["ok":false,"code":error.code]}
   catch{result=["ok":false,"code":"COMPUTER_NATIVE_FAILED"]}
   result["id"]=request["id"] ?? NSNull()
   if let data=try? JSONSerialization.data(withJSONObject:result,options:[.sortedKeys]),let text=String(data:data,encoding:.utf8){print(text);fflush(stdout)}
  }
 }
 DispatchQueue.main.async{application.terminate(nil)}
}
application.run()
