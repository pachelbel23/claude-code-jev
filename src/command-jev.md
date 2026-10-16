---
description: Jev 開關：on｜lite｜off｜status｜test <文字>｜log [筆數]（lite＝只留 Skill 建議與任務類型）
argument-hint: on|lite|off|status|test <文字>|log [n]
allowed-tools: Bash(node:*)
disable-model-invocation: true
---
!`node "~/.claude/jev/jev.mjs" cli $ARGUMENTS`

把上面的輸出原樣顯示給使用者，不要補充或判斷。
