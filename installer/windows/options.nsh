!include "nsDialogs.nsh"
!include "FileFunc.nsh"
!include "nsProcess.nsh"

!ifndef BUILD_UNINSTALLER
Var FoxdownPreviousFolder
!endif

!macro customCheckAppRunning
  ; Use the bundled process plugin so folder names stay out of shell commands.
  StrCpy $0 "$INSTDIR"
  !ifndef BUILD_UNINSTALLER
    ${If} $FoxdownPreviousFolder != ""
      StrCpy $0 "$FoxdownPreviousFolder"
    ${EndIf}
  !endif
  ${If} ${FileExists} "$0\${APP_EXECUTABLE_FILENAME}"
    ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $0
    ${If} $0 == 0
      ${IfNot} ${isUpdated}
        MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK +2
        Quit
      ${EndIf}
      ${nsProcess::CloseProcess} "${APP_EXECUTABLE_FILENAME}" $0
      Sleep 1000
      ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $0
      ${If} $0 == 0
        ${nsProcess::KillProcess} "${APP_EXECUTABLE_FILENAME}" $0
        Sleep 300
      ${EndIf}
      ${Do}
        ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $0
        ${If} $0 != 0
          ${ExitDo}
        ${EndIf}
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY +2
        Quit
      ${Loop}
    ${EndIf}
    ${nsProcess::Unload}
  ${EndIf}
!macroend

!ifndef BUILD_UNINSTALLER
Var FoxdownLanguage
Var FoxdownLanguageChoice
Var FoxdownLanguageLabel
Var FoxdownPathLabel
Var FoxdownPathInput
Var FoxdownBrowse
Var FoxdownShortcut
Var FoxdownPathHint
Var FoxdownNext
Var FoxdownCancel
Var FoxdownDesktopShortcut

!macro customInit
  StrCpy $FoxdownDesktopShortcut ${BST_CHECKED}
  ReadRegStr $FoxdownPreviousFolder SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $FoxdownPreviousFolder != ""
    !insertmacro setLinkVars
    ${IfNot} ${FileExists} "$oldDesktopLink"
      StrCpy $FoxdownDesktopShortcut ${BST_UNCHECKED}
    ${EndIf}
  ${EndIf}
!macroend

!macro customInstallMode
  ; Existing per-machine installations keep the builder's elevation flow.
  ${If} $installMode == "CurrentUser"
  ${AndIfNot} ${isForAllUsers}
    Abort
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  PageEx custom
    PageCallbacks FoxdownOptionsPage FoxdownOptionsLeave
    Caption " "
  PageExEnd
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW FoxdownProgressShow
!macroend

!macro customFinishPage
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW FoxdownFinishShow
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION FoxdownLaunch
  !define MUI_FINISHPAGE_RUN_NOTCHECKED
  !insertmacro MUI_PAGE_FINISH
!macroend

!macro customHeader
Function FoxdownOptionsPage
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 6u 100% 11u ""
  Pop $FoxdownLanguageLabel
  ${NSD_CreateDropList} 0 21u 150u 80u ""
  Pop $FoxdownLanguageChoice
  ${NSD_CB_AddString} $FoxdownLanguageChoice "English"
  ${NSD_CB_AddString} $FoxdownLanguageChoice "简体中文"
  ${If} $FoxdownLanguage == ""
    StrCpy $FoxdownLanguage 0
    ${If} $LANGUAGE == 2052
      StrCpy $FoxdownLanguage 1
    ${EndIf}
  ${EndIf}
  SendMessage $FoxdownLanguageChoice ${CB_SETCURSEL} $FoxdownLanguage 0
  ${NSD_OnChange} $FoxdownLanguageChoice FoxdownLanguageChanged

  ${NSD_CreateLabel} 0 52u 100% 11u ""
  Pop $FoxdownPathLabel
  ${NSD_CreateDirRequest} 0 67u 77% 13u "$INSTDIR"
  Pop $FoxdownPathInput
  ${NSD_CreateBrowseButton} 79% 66u 21% 15u ""
  Pop $FoxdownBrowse
  ${NSD_OnClick} $FoxdownBrowse FoxdownBrowseFolder

  ${NSD_CreateLabel} 0 86u 100% 21u ""
  Pop $FoxdownPathHint
  ${NSD_CreateCheckbox} 0 114u 100% 14u ""
  Pop $FoxdownShortcut
  ${NSD_SetState} $FoxdownShortcut $FoxdownDesktopShortcut

  GetDlgItem $FoxdownNext $HWNDPARENT 1
  GetDlgItem $FoxdownCancel $HWNDPARENT 2
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_HIDE}
  Call FoxdownRenderOptions
  nsDialogs::Show
FunctionEnd

Function FoxdownLanguageChanged
  Pop $0
  SendMessage $FoxdownLanguageChoice ${CB_GETCURSEL} 0 0 $FoxdownLanguage
  Call FoxdownRenderOptions
FunctionEnd

Function FoxdownRenderOptions
  ${If} $FoxdownLanguage == 1
    !insertmacro MUI_HEADER_TEXT "安装 Foxdown" "选择语言、安装目录和桌面快捷方式。"
    ${NSD_SetText} $FoxdownLanguageLabel "安装界面语言"
    ${NSD_SetText} $FoxdownPathLabel "安装目录"
    ${NSD_SetText} $FoxdownBrowse "浏览…"
    ${NSD_SetText} $FoxdownPathHint "可以直接输入路径，也可以浏览并选择父目录。"
    ${NSD_SetText} $FoxdownShortcut "创建桌面快捷方式"
    ${NSD_SetText} $FoxdownNext "安装"
    ${NSD_SetText} $FoxdownCancel "取消"
    SendMessage $HWNDPARENT ${WM_SETTEXT} 0 "STR:Foxdown 安装程序"
  ${Else}
    !insertmacro MUI_HEADER_TEXT "Install Foxdown" "Choose the language, destination and desktop shortcut."
    ${NSD_SetText} $FoxdownLanguageLabel "Installer language"
    ${NSD_SetText} $FoxdownPathLabel "Installation folder"
    ${NSD_SetText} $FoxdownBrowse "Browse…"
    ${NSD_SetText} $FoxdownPathHint "Enter a path or browse for the parent folder."
    ${NSD_SetText} $FoxdownShortcut "Create a desktop shortcut"
    ${NSD_SetText} $FoxdownNext "Install"
    ${NSD_SetText} $FoxdownCancel "Cancel"
    SendMessage $HWNDPARENT ${WM_SETTEXT} 0 "STR:Foxdown Setup"
  ${EndIf}
FunctionEnd

Function FoxdownBrowseFolder
  Pop $0
  ${NSD_GetText} $FoxdownPathInput $0
  ${If} $FoxdownLanguage == 1
    nsDialogs::SelectFolderDialog "选择 Foxdown 安装目录" "$0"
  ${Else}
    nsDialogs::SelectFolderDialog "Choose the Foxdown installation folder" "$0"
  ${EndIf}
  Pop $0
  ${If} $0 != "error"
  ${AndIf} $0 != ""
    ${GetFileName} "$0" $1
    ${If} $0 != $FoxdownPreviousFolder
    ${AndIf} $1 != "${APP_FILENAME}"
      StrCpy $1 $0 1 -1
      ${If} $1 == "\"
        StrCpy $0 "$0${APP_FILENAME}"
      ${Else}
        StrCpy $0 "$0\${APP_FILENAME}"
      ${EndIf}
    ${EndIf}
    ${NSD_SetText} $FoxdownPathInput "$0"
  ${EndIf}
FunctionEnd

Function FoxdownOptionsLeave
  ${NSD_GetText} $FoxdownPathInput $0
  ${NSD_GetState} $FoxdownShortcut $FoxdownDesktopShortcut
  StrCpy $1 $0 2 1
  ${If} $1 != ":\"
    Goto FoxdownInvalidPath
  ${EndIf}
  ; Unlike the NSIS command, the Windows API also resolves new folders.
  System::Call 'kernel32::GetFullPathNameW(w r0, i ${NSIS_MAX_STRLEN}, w .r2, p 0) i.r1'
  ${If} $1 <= 3
  ${OrIf} $1 >= ${NSIS_MAX_STRLEN}
    Goto FoxdownInvalidPath
  ${EndIf}
  StrCpy $0 $2
  StrCpy $1 $0 2 1
  ${If} $1 != ":\"
    Goto FoxdownInvalidPath
  ${EndIf}
  StrCpy $1 $0 1 -1
  ${If} $1 == "\"
    StrCpy $0 $0 -1
  ${EndIf}

  ClearErrors
  CreateDirectory "$0"
  ${If} ${Errors}
    Goto FoxdownInvalidPath
  ${EndIf}
  System::Call 'kernel32::GetFileAttributesW(w r0) i.r1'
  IntOp $1 $1 & 0x410 ; must be a directory and must not be a junction or symlink
  ${IfNot} $1 = 0x10
    Goto FoxdownInvalidPath
  ${EndIf}

  ; The generated uninstaller removes its installation folder recursively.
  ; Never accept an unrelated folder containing user files.
  ${If} $0 != $FoxdownPreviousFolder
    ${DirState} "$0" $1
    ${If} $1 == -1
      Goto FoxdownInvalidPath
    ${ElseIf} $1 == 1
      ${If} $FoxdownLanguage == 1
        MessageBox MB_OK|MB_ICONEXCLAMATION "目标目录已有文件。请选择一个空目录。"
      ${Else}
        MessageBox MB_OK|MB_ICONEXCLAMATION "The destination already contains files. Choose an empty folder."
      ${EndIf}
      Abort
    ${EndIf}
  ${EndIf}

  ClearErrors
  GetTempFileName $1 "$0"
  ${If} ${Errors}
    Goto FoxdownInvalidPath
  ${EndIf}
  Delete "$1"
  StrCpy $INSTDIR $0
  Return

  FoxdownInvalidPath:
  ${If} $FoxdownLanguage == 1
    MessageBox MB_OK|MB_ICONEXCLAMATION "请选择可写入的本地安装目录。"
  ${Else}
    MessageBox MB_OK|MB_ICONEXCLAMATION "Choose a writable installation folder on a local drive."
  ${EndIf}
  Abort
FunctionEnd

Function FoxdownProgressShow
  ; NSIS selects its language table at startup. Refresh the visible controls
  ; using the in-page choice and keep the progress bar native.
  ShowWindow $mui.InstFilesPage.Text ${SW_HIDE}
  ${If} $FoxdownLanguage == 1
    !insertmacro MUI_HEADER_TEXT "正在安装 Foxdown" "请等待文件复制完成。"
    ${NSD_SetText} $FoxdownCancel "取消"
    SendMessage $HWNDPARENT ${WM_SETTEXT} 0 "STR:Foxdown 安装程序"
  ${Else}
    !insertmacro MUI_HEADER_TEXT "Installing Foxdown" "Please wait while the files are copied."
    ${NSD_SetText} $FoxdownCancel "Cancel"
    SendMessage $HWNDPARENT ${WM_SETTEXT} 0 "STR:Foxdown Setup"
  ${EndIf}
FunctionEnd

Function FoxdownFinishShow
  GetDlgItem $FoxdownNext $HWNDPARENT 1
  ${If} $FoxdownLanguage == 1
    ${NSD_SetText} $mui.FinishPage.Title "Foxdown 安装完成"
    ${NSD_SetText} $mui.FinishPage.Text "点击「完成」关闭安装程序。"
    ${NSD_SetText} $mui.FinishPage.Run "启动 Foxdown"
    ${NSD_SetText} $FoxdownNext "完成"
    SendMessage $HWNDPARENT ${WM_SETTEXT} 0 "STR:Foxdown 安装程序"
  ${Else}
    ${NSD_SetText} $mui.FinishPage.Title "Foxdown is installed"
    ${NSD_SetText} $mui.FinishPage.Text "Click Finish to close the installer."
    ${NSD_SetText} $mui.FinishPage.Run "Launch Foxdown"
    ${NSD_SetText} $FoxdownNext "Finish"
    SendMessage $HWNDPARENT ${WM_SETTEXT} 0 "STR:Foxdown Setup"
  ${EndIf}
FunctionEnd

Function FoxdownLaunch
  ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" ""
FunctionEnd
!macroend

!macro customInstall
  ${If} $FoxdownDesktopShortcut == ${BST_CHECKED}
  ${AndIfNot} ${isNoDesktopShortcut}
    CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  ${ElseIf} $FoxdownPreviousFolder != ""
  ${AndIf} ${FileExists} "$oldDesktopLink"
    WinShell::UninstShortcut "$oldDesktopLink"
    Delete "$oldDesktopLink"
  ${EndIf}
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
!endif

!macro customUnInstall
  ${IfNot} ${isKeepShortcuts}
    WinShell::UninstShortcut "$oldDesktopLink"
    Delete "$oldDesktopLink"
  ${EndIf}
!macroend
