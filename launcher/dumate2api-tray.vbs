' dumate2api tray launcher -- starts the PowerShell UI with NO console window.
'
' Why a .vbs: "powershell.exe -WindowStyle Hidden" still flashes a console for a
' moment. WScript.Shell.Run with window style 0 never creates one.
'
' KEEP THIS FILE PURE ASCII: wscript reads .vbs as ANSI, so Chinese here would
' be garbled (and could break string quoting). The UI text lives in the .ps1.

Option Explicit

Dim fso, sh, here, ps1, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
ps1  = fso.BuildPath(here, "dumate2api-tray.ps1")

If Not fso.FileExists(ps1) Then
    MsgBox "Cannot find:" & vbCrLf & ps1, 16, "dumate2api"
    WScript.Quit 1
End If

' -STA is required: WinForms needs a single-threaded apartment in PowerShell 5.1
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File """ & ps1 & """"
sh.Run cmd, 0, False
