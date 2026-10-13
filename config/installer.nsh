; 使用稳定的应用注册表标识检测安装；修改显示名称也能找到原安装。
; 静默重装不能完成卸载引导，因此已有安装时必须使用交互式安装向导。
!macro proctorRequireInteractive ROOT_KEY
  ReadRegStr $R0 ${ROOT_KEY} "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  ReadRegStr $R1 ${ROOT_KEY} "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${If} $R0 != ""
  ${OrIf} $R1 != ""
    DetailPrint "检测到已有安装，请打开安装向导，先卸载再安装。"
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro customInit
  ${If} ${Silent}
    !insertmacro proctorRequireInteractive HKLM
    !insertmacro proctorRequireInteractive HKCU
  ${EndIf}
!macroend

; 新安装包自己的卸载器提供可见向导，不依赖已安装版本的静默卸载设置。
!macro customHeader
  SilentUnInstall normal
!macroend

!macro customUnInit
  ${GetParameters} $R0
  ${GetOptions} $R0 "--proctor-interactive-uninstall" $R1
  ${IfNot} ${Errors}
    SetSilent normal
  ${EndIf}
  ClearErrors
!macroend

; 在选定安装范围和目录之后、写入程序文件之前运行安装包内置的卸载向导。
; 使用与原安装相同的应用标识和范围，保留 data，并移除原安装的程序和快捷方式。
; 最后一个 _?= 参数指向原安装目录，使卸载器直接运行，便于真正等待其退出。
!macro proctorUninstallRegistered ROOT_KEY MODE
  ReadRegStr $proctorOldCommand ${ROOT_KEY} "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  ReadRegStr $proctorOldDirectory ${ROOT_KEY} "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${If} $proctorOldCommand != ""
  ${OrIf} $proctorOldDirectory != ""
    !if "${ROOT_KEY}" == "HKLM"
      ${IfNot} ${UAC_IsAdmin}
        MessageBox MB_OK|MB_ICONEXCLAMATION "检测到为所有用户安装的客户端。请关闭安装器，以管理员身份重新运行安装包，先卸载再安装。"
        SetErrorLevel 2
        Quit
      ${EndIf}
    !endif

    ; 仅提取注册表中带引号的可执行文件路径，不直接执行附带参数。
    Push $proctorOldCommand
    Call GetInQuotes
    Pop $proctorOldUninstaller
    ${If} $proctorOldDirectory == ""
    ${AndIf} $proctorOldUninstaller != ""
      Push $proctorOldUninstaller
      Call GetFileParent
      Pop $proctorOldDirectory
    ${EndIf}
    ${If} $proctorOldDirectory == ""
    ${OrIfNot} ${FileExists} "$proctorOldDirectory\*.*"
      MessageBox MB_OK|MB_ICONSTOP "检测到已有安装，但找不到有效的安装目录。请先通过 Windows 设置中的应用管理修复或卸载原客户端，再运行安装包。安装已停止，原监考数据不会被覆盖。"
      SetErrorLevel 2
      Quit
    ${EndIf}

    MessageBox MB_OKCANCEL|MB_ICONINFORMATION|MB_DEFBUTTON2 "本机已安装监考客户端：$\r$\n$proctorOldDirectory$\r$\n$\r$\n请先保存作答并退出监考客户端。点击【确定】打开卸载向导，卸载成功后再继续安装；点击【取消】退出安装。$\r$\n$\r$\n安装目录的 data 文件夹将保留；若更换安装目录，请一并迁移该文件夹。" /SD IDCANCEL IDOK +3
      SetErrorLevel 1
      Quit

    StrCpy $proctorOldTemporary "$PLUGINSDIR\proctor-uninstall-${MODE}.exe"
    ClearErrors
    ; 提取 builder 为本安装包生成并签名的卸载器，原安装的卸载器可以已丢失。
    File "/oname=$PLUGINSDIR\proctor-uninstall-${MODE}.exe" "${UNINSTALLER_OUT_FILE}"
    ${If} ${Errors}
    ${OrIfNot} ${FileExists} "$proctorOldTemporary"
      MessageBox MB_OK|MB_ICONSTOP "无法准备卸载向导。安装已停止，请检查临时目录权限后重试。监考数据已保留。"
      SetErrorLevel 2
      Quit
    ${EndIf}
    ; 先隐藏安装器，避免卸载向导被它遮挡；所有失败路径均先恢复安装器。
    ShowWindow $HWNDPARENT ${SW_HIDE}
    ClearErrors
    ; 不使用 /S 或 --updated，交互标志也明确禁止静默卸载。
    ExecWait '"$proctorOldTemporary" --proctor-interactive-uninstall /KEEP_APP_DATA /${MODE} _?=$proctorOldDirectory' $proctorOldExitCode
    ; ShowWindow 和 BringToFront 可能影响错误标志，先保存启动结果。
    StrCpy $proctorOldLaunchFailed "0"
    ${If} ${Errors}
      StrCpy $proctorOldLaunchFailed "1"
    ${EndIf}
    ShowWindow $HWNDPARENT ${SW_SHOW}
    BringToFront
    ${If} $proctorOldLaunchFailed == "1"
      MessageBox MB_OK|MB_ICONSTOP "无法打开卸载向导。安装已停止，请检查文件权限后重试。监考数据已保留。"
      SetErrorLevel 2
      Quit
    ${EndIf}
    Delete "$proctorOldTemporary"
    ${If} $proctorOldExitCode != 0
      MessageBox MB_OK|MB_ICONEXCLAMATION "卸载已取消或失败，安装不会继续。请关闭监考客户端后重新运行安装包。监考数据已保留。"
      SetErrorLevel 2
      Quit
    ${EndIf}

    ; 有些卸载程序取消时也返回零，必须再次确认安装登记已经移除。
    ReadRegStr $proctorOldCommand ${ROOT_KEY} "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
    ReadRegStr $proctorOldDirectory ${ROOT_KEY} "${INSTALL_REGISTRY_KEY}" "InstallLocation"
    ${If} $proctorOldCommand != ""
    ${OrIf} $proctorOldDirectory != ""
      MessageBox MB_OK|MB_ICONSTOP "原客户端尚未完成卸载，安装已停止。请完成卸载后重新运行安装包。监考数据已保留。"
      SetErrorLevel 2
      Quit
    ${EndIf}
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  Var proctorOldCommand
  Var proctorOldDirectory
  Var proctorOldUninstaller
  Var proctorOldTemporary
  Var proctorOldExitCode
  Var proctorOldLaunchFailed
  Page custom proctorUninstallBeforeInstall
  Function proctorUninstallBeforeInstall
    InitPluginsDir
    ; 两种安装范围均检查，避免为当前用户安装时遗漏已有的全用户安装。
    !insertmacro proctorUninstallRegistered HKLM allusers
    !insertmacro proctorUninstallRegistered HKCU currentuser
    ClearErrors
    ; 此处 Abort 仅跳过自定义页面，随后进入正常安装进度页。
    Abort
  FunctionEnd
!macroend

; 安装后不启动普通权限进程，用户点击完成，再从桌面以管理员身份打开。
!macro customFinishPage
  !define MUI_FINISHPAGE_TITLE "安装完成"
  !define MUI_FINISHPAGE_TEXT "${PRODUCT_NAME}已安装。$\r$\n$\r$\n请点击【完成】，然后在桌面右键${PRODUCT_NAME}，选择【以管理员身份运行】。$\r$\n$\r$\n监考日志、设备身份和更新缓存保存在安装目录的 data 文件夹。"
  !insertmacro MUI_PAGE_FINISH
!macroend

; 覆盖默认 RMDir /r，更新/卸载时保留 data 下尚未上传的监考证据。
; 安装器始终创建独立产品子目录，data 是唯一运行数据目录。
!macro customRemoveFiles
  SetOutPath $TEMP
  ; 沿用 builder 的原子搬迁与回滚，先确认程序文件可移除，再删除目录。
  ; data 从一开始就不参与搬迁，升级失败也不会影响监考证据。
  CreateDirectory "$PLUGINSDIR\old-install"
  FindFirst $R0 $R1 "$INSTDIR\*.*"
  ${DoWhile} $R1 != ""
    ${If} $R1 != "."
    ${AndIf} $R1 != ".."
    ${AndIf} $R1 != "data"
      StrCpy $R2 "0"
      ${If} ${FileExists} "$INSTDIR\$R1\*.*"
        CreateDirectory "$PLUGINSDIR\old-install\$R1"
        Push "\$R1"
        Call un.atomicRMDir
        Pop $R2
      ${Else}
        ClearErrors
        Rename "$INSTDIR\$R1" "$PLUGINSDIR\old-install\$R1"
        StrCmp $R1 "${UNINSTALL_FILENAME}" 0 +2
          ClearErrors
        IfErrors 0 +2
          StrCpy $R2 "$INSTDIR\$R1"
      ${EndIf}
      ${If} $R2 != "0"
        FindClose $R0
        DetailPrint "文件正在使用，已取消操作：$R2"
        Push ""
        Call un.restoreFiles
        Pop $R2
        Abort "无法移除正在使用的程序文件，请关闭监考客户端后重试。监考数据已保留。"
      ${EndIf}
    ${EndIf}
    FindNext $R0 $R1
  ${Loop}
  FindClose $R0
  FindFirst $R0 $R1 "$INSTDIR\*.*"
  ${DoWhile} $R1 != ""
    ${If} $R1 != "."
    ${AndIf} $R1 != ".."
    ${AndIf} $R1 != "data"
      IfFileExists "$INSTDIR\$R1\*.*" 0 +3
        RMDir /r "$INSTDIR\$R1"
        Goto +2
      Delete "$INSTDIR\$R1"
    ${EndIf}
    FindNext $R0 $R1
  ${Loop}
  FindClose $R0
  RMDir "$INSTDIR"
!macroend
