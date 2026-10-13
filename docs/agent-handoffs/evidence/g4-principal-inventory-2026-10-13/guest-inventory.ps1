# Read-only diagnostics. No application payload is staged or launched.
param([Parameter(Mandatory=$true)][string]$RunId)
$ErrorActionPreference='Stop'
if ((Get-Content C:\G4PrincipalInput\run-id.txt -Raw).Trim() -ne $RunId) { throw 'Run identity mismatch.' }
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class PrincipalInventory {
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int id);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr data,int length,out int needed);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertSidToStringSid(IntPtr sid,out IntPtr text);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr ptr);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool LookupPrivilegeName(string system,ref Luid luid,StringBuilder name,ref int length);
 [StructLayout(LayoutKind.Sequential)] struct Luid { public uint Low; public int High; }
 [StructLayout(LayoutKind.Sequential)] struct SidAttr { public IntPtr Sid; public uint Attributes; }
 [StructLayout(LayoutKind.Sequential)] struct Groups { public uint Count; public SidAttr First; }
 static IntPtr Info(IntPtr token,int kind) { int n; GetTokenInformation(token,kind,IntPtr.Zero,0,out n); if(n<=0) throw new Exception("Token info "+kind+" length failed: "+Marshal.GetLastWin32Error()); IntPtr p=Marshal.AllocHGlobal(n); if(!GetTokenInformation(token,kind,p,n,out n)) { int e=Marshal.GetLastWin32Error(); Marshal.FreeHGlobal(p); throw new Exception("Token info "+kind+" failed: "+e); } return p; }
 static string Sid(IntPtr p) { IntPtr s; if(!ConvertSidToStringSid(p,out s)) throw new Exception("SID conversion failed"); try{return Marshal.PtrToStringUni(s);}finally{LocalFree(s);} }
 static string FirstSid(IntPtr token,int kind) { IntPtr p=Info(token,kind); try{return Sid(Marshal.ReadIntPtr(p));}finally{Marshal.FreeHGlobal(p);} }
 static int Integer(IntPtr token,int kind) { IntPtr p=Info(token,kind); try{return Marshal.ReadInt32(p);}finally{Marshal.FreeHGlobal(p);} }
 static object[] GroupList(IntPtr token,int kind) { IntPtr p=Info(token,kind); try { int count=Marshal.ReadInt32(p),offset=Marshal.OffsetOf(typeof(Groups),"First").ToInt32(),stride=Marshal.SizeOf(typeof(SidAttr)); var list=new List<object>(); for(int i=0;i<count;i++) { SidAttr row=(SidAttr)Marshal.PtrToStructure(IntPtr.Add(p,offset+i*stride),typeof(SidAttr)); list.Add(new {sid=Sid(row.Sid),attributes=row.Attributes,enabled=(row.Attributes&4)!=0,denyOnly=(row.Attributes&16)!=0}); }return list.ToArray(); }finally{Marshal.FreeHGlobal(p);} }
 static object[] Privileges(IntPtr token) { IntPtr p=Info(token,3); try { int count=Marshal.ReadInt32(p); var list=new List<object>(); for(int i=0;i<count;i++){IntPtr row=IntPtr.Add(p,4+i*12); Luid luid=(Luid)Marshal.PtrToStructure(row,typeof(Luid)); uint flags=unchecked((uint)Marshal.ReadInt32(row,8)); int n=0; LookupPrivilegeName(null,ref luid,null,ref n); var name=new StringBuilder(n+1); n=name.Capacity; bool ok=LookupPrivilegeName(null,ref luid,name,ref n); list.Add(new{name=ok?name.ToString():"LUID:"+luid.High+":"+luid.Low,attributes=flags,enabled=(flags&2)!=0});}return list.ToArray(); }finally{Marshal.FreeHGlobal(p);} }
 public static object Read(int id) { IntPtr p=OpenProcess(0x1000,false,id); if(p==IntPtr.Zero)return new{error="OpenProcess",win32Error=Marshal.GetLastWin32Error()}; try {IntPtr t; if(!OpenProcessToken(p,8,out t))return new{error="OpenProcessToken",win32Error=Marshal.GetLastWin32Error()};try{return new{userSid=FirstSid(t,1),ownerSid=FirstSid(t,4),integritySid=FirstSid(t,25),elevation=Integer(t,20),elevationType=Integer(t,18),tokenType=Integer(t,8),sessionId=Integer(t,12),groups=GroupList(t,2),restrictedSids=GroupList(t,11),privileges=Privileges(t)};}finally{CloseHandle(t);} }finally{CloseHandle(p);} }
}
'@
$start=[DateTime]::UtcNow.ToString('o')
$images=@{}
$processes=@(Get-CimInstance Win32_Process | Sort-Object ProcessId | ForEach-Object {
    $row=$_
    $path=$row.ExecutablePath
    if($path -and -not $images.ContainsKey($path)) {
        try {
            $signature=Get-AuthenticodeSignature -LiteralPath $path
            $version=[Diagnostics.FileVersionInfo]::GetVersionInfo($path)
            $images[$path]=[ordered]@{path=$path;sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant();signatureStatus=[string]$signature.Status;signer=if($signature.SignerCertificate){$signature.SignerCertificate.Subject}else{$null};company=$version.CompanyName;version=$version.FileVersion}
        } catch { $images[$path]=[ordered]@{path=$path;error=$_.Exception.Message} }
    }
    try { $token=[PrincipalInventory]::Read([int]$row.ProcessId) } catch { $token=@{error=$_.Exception.Message} }
    [ordered]@{pid=$row.ProcessId;parentPid=$row.ParentProcessId;name=$row.Name;path=$path;commandLine=$row.CommandLine;sessionId=$row.SessionId;creationDate=$row.CreationDate;token=$token}
})
$os=Get-CimInstance Win32_OperatingSystem
$users=@(Get-LocalUser | Select-Object Name,@{n='sid';e={$_.SID.Value}},Enabled,@{n='principalSource';e={[string]$_.PrincipalSource}})
$administrators=@(Get-LocalGroupMember -SID S-1-5-32-544 | Select-Object Name,@{n='sid';e={$_.SID.Value}},ObjectClass,@{n='principalSource';e={[string]$_.PrincipalSource}})
$report=[ordered]@{schemaVersion=1;purpose='Read-only initial clean Windows Sandbox principal and image inventory; OS baseline observation, not tamper attestation';runId=$RunId;startedUtc=$start;finishedUtc=[DateTime]::UtcNow.ToString('o');collectorPid=$PID;collectorIdentity=[Security.Principal.WindowsIdentity]::GetCurrent().Name;os=[ordered]@{caption=$os.Caption;version=$os.Version;build=$os.BuildNumber;architecture=$os.OSArchitecture};users=$users;administrators=$administrators;processes=$processes;images=@($images.Values | Sort-Object path)}
[IO.File]::WriteAllText('C:\G4PrincipalOutput\principal-inventory.json',($report | ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
exit 0
