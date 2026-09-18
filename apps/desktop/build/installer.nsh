!macro customUnInstall
  System::Call 'Kernel32::SetEnvironmentVariable(t "CLAWDI_NO_AUTO_UPDATE", t "1")i.r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t "CLAWDI_NO_UPDATE_CHECK", t "1")i.r0'
  ; Keep the unit as Sync intent during upgrade, remove it on real uninstall.
  ${if} ${isUpdated}
    nsExec::ExecToStack '"$INSTDIR\resources\native\clawdi.exe" daemon stop'
  ${else}
    nsExec::ExecToStack '"$INSTDIR\resources\native\clawdi.exe" daemon uninstall'
  ${endif}
  Pop $0
  Pop $1
  ${if} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "Could not stop Clawdi Sync. Disable Sync and retry." /SD IDOK
    SetErrorLevel 1
    Abort
  ${endif}
!macroend
