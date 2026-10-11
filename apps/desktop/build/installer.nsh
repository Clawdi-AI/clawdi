!macro customUnInstall
  System::Call 'Kernel32::SetEnvironmentVariable(t "CLAWDI_NO_AUTO_UPDATE", t "1")i.r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t "CLAWDI_NO_UPDATE_CHECK", t "1")i.r0'
  ; Keep the unit as Sync intent during upgrade; full cleanup only on real uninstall.
  ${if} ${isUpdated}
    nsExec::ExecToStack '"$INSTDIR\resources\native\clawdi.exe" daemon stop'
    Pop $0
    Pop $1
    ${if} $0 != 0
      MessageBox MB_OK|MB_ICONSTOP "Could not stop Clawdi Sync. Disable Sync and retry." /SD IDOK
      SetErrorLevel 1
      Abort
    ${endif}
  ${else}
    ; Preserve the user's explicit unchecked checkbox across the second CLI cleanup.
    ${GetParameters} $R0
    ClearErrors
    ${GetOptions} "$R0" "/KEEPCLI" $R1
    ${ifNot} ${Errors}
      System::Call 'Kernel32::SetEnvironmentVariable(t "CLAWDI_UNINSTALL_KEEP_CLI", t "1")i.r0'
    ${endif}
    ; Run the shared Desktop cleanup before deleting CLI credentials. The executable
    ; is still installed, and no cleanup entry is invoked in the upgrade branch.
    nsExec::ExecToStack /TIMEOUT=240000 '"$INSTDIR\Clawdi.exe" --clawdi-uninstall-cleanup'
    Pop $0
    Pop $1
    ; The bundled native CLI is available before NSIS removes app files. It removes
    ; the shared CLI only when its validated metadata records installedBy=desktop.
    ; CLI failures are best effort and must never prevent NSIS from completing.
    nsExec::ExecToStack '"$INSTDIR\resources\native\clawdi.exe" uninstall --yes'
    Pop $0
    Pop $1
    ; Desktop cleanup owns launcher/PATH removal too: KEEPCLI preserves only
    ; a marked shim targeting an ownership-verified shared native CLI.
    ; Registered by app.setAsDefaultProtocolClient("clawdi-desktop") on launch.
    DeleteRegKey HKCU "Software\Classes\clawdi-desktop"
  ${endif}
!macroend
