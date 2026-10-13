// Read-only Shell association enumeration; never changes associations or invokes handlers.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export interface WindowsAssociatedApp { executable: string; label: string }
const run = promisify(execFile)
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
[ComImport, Guid("F04061AC-1659-4A3F-A954-775AA57FC083"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface AssocHandler {
 [PreserveSig] int GetName([MarshalAs(UnmanagedType.LPWStr)] out string name);
 [PreserveSig] int GetUIName([MarshalAs(UnmanagedType.LPWStr)] out string name);
}
[ComImport, Guid("973810AE-9599-4B88-9E4D-6EE98C9552DA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface EnumHandlers {
 [PreserveSig] int Next(uint count, [MarshalAs(UnmanagedType.Interface)] out AssocHandler handler, out uint fetched);
}
public class AssociatedApp { public string executable; public string label; }
public class ShellAssociations {
 [DllImport("shell32.dll", CharSet=CharSet.Unicode)]
 static extern int SHAssocEnumHandlers(string extension, uint filter, out EnumHandlers handlers);
 public static AssociatedApp[] Read(string extension) {
  EnumHandlers items; int hr=SHAssocEnumHandlers(extension, 0, out items);
  if(hr<0) Marshal.ThrowExceptionForHR(hr);
  var result=new List<AssociatedApp>();
  if(items==null) return result.ToArray();
  try {
   for(int i=0;i<128;i++) {
    AssocHandler handler; uint fetched;
    if(items.Next(1,out handler,out fetched)!=0 || fetched==0) break;
    try { string name,label; if(handler.GetName(out name)==0) { handler.GetUIName(out label); result.Add(new AssociatedApp { executable=name,label=label??"" }); } }
    finally { if(handler!=null) Marshal.ReleaseComObject(handler); }
   }
  } finally { Marshal.ReleaseComObject(items); }
  return result.ToArray();
 }
}
'@
$items = @([ShellAssociations]::Read($env:LITTLESHEEP_ASSOC_EXTENSION))
ConvertTo-Json -InputObject $items -Compress
`

export async function queryWindowsAssociatedApplications(extension: string): Promise<WindowsAssociatedApp[]> {
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Sta', '-Command', SCRIPT], {
    windowsHide: true, timeout: 10000, maxBuffer: 256 * 1024,
    env: { ...process.env, LITTLESHEEP_ASSOC_EXTENSION: extension },
  })
  const parsed: unknown = JSON.parse(stdout.replace(/^\uFEFF/u, '').trim())
  if (!Array.isArray(parsed)) throw new Error('Invalid Shell association response')
  return parsed.filter((value): value is WindowsAssociatedApp => Boolean(value && typeof value === 'object'
    && typeof value.executable === 'string' && typeof value.label === 'string'))
}
