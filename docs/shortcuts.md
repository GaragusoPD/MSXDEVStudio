# Keyboard shortcuts

Every binding in MSXDEVStudio, in one place. The application menu shows the main
ones next to their items.

## Anywhere in the workbench

| Shortcut | Does |
|---|---|
| `Ctrl+S` | Save the active tab |
| `Ctrl+Shift+S` | Save every tab with unsaved changes |
| `Ctrl+W` | Close the active tab (asks first if it has unsaved changes) |
| `Ctrl+Tab` | Switch to the tab you were in before this one |
| `Ctrl+Shift+B` | Build |
| `F5` | Run — builds first if it needs to |
| ``Ctrl+` `` | Show or hide the terminal panel |

`Ctrl+S` reaches whichever editor owns the tab, so it saves a tile bank, a map
or a `.c` file the same way. Middle-clicking a tab closes it, with the same
prompt as `Ctrl+W`.

> ``Ctrl+` `` is bound to the *physical* key left of `1`, not to the backtick
> character, so it still works on Nordic and Spanish layouts where backtick is
> a dead key.

## In the resource editors

These work in the tile, bitmap-tile, sprite, map, screen and SFX editors. They
are ignored while you are typing in a text box, so naming a block does not
trigger them.

| Shortcut | Does |
|---|---|
| `Ctrl+Z` | Undo |
| `Ctrl+Y` or `Ctrl+Shift+Z` | Redo |
| `Ctrl+C` / `Ctrl+V` | Copy and paste the selection — tile and map editors |
| `Delete` / `Backspace` | Clear the selected cells — map editor |
| `Escape` | Drop the selection — map editor |
| `Space` | Play or stop the current effect — SFX editor |
| `P` | Play the effect from the start — SFX editor |

Each editor keeps its own undo history, and it survives switching tabs.

## Mouse

| Gesture | Does |
|---|---|
| Left / right click | Draw / erase — sprite and screen editors |
| Left / right click | Paint foreground / background — tile editor |
| Drag a rectangle | Edit those tiles as one image — tile editor |
| `Shift`+click | Extend the tile selection |
| `Alt`+drag a tile onto another | Reorder the bank; maps and blocks follow |
| Click, or `Shift`+click / drag | Pick one tile, or a multi-tile stamp — map editor |
| Drag with the cut tool | Name a fragment — screen editor |

## In the code editor

The code editor is Monaco, the editor from VS Code, and it brings its own
bindings — `Ctrl+F` find, `Ctrl+H` replace, `Ctrl+/` comment, `Ctrl+Space`
completions, `Alt+↑`/`Alt+↓` move line, and the rest. `Ctrl+Space` is the one
worth remembering: it completes against the whole MSXgl API.

## Elsewhere

| Shortcut | Does |
|---|---|
| `Ctrl+Enter` | Commit, from the message box in the Git panel |
| `Escape` | Close a context menu |
| `Ctrl+X` / `Ctrl+C` / `Ctrl+V` | Cut, copy, paste in text fields |
| `Ctrl+A` | Select all |
| `Ctrl+0`, `Ctrl+=`, `Ctrl+-` | Reset, increase, decrease the interface zoom |
| `F11` | Full screen |

## When a terminal has focus

A focused terminal takes every key except ``Ctrl+` ``, because a shell needs
them: `Ctrl+W` deletes a word, `Ctrl+S` is flow control, `Ctrl+C` interrupts.
Press ``Ctrl+` `` to leave, and the workbench shortcuts apply again.
