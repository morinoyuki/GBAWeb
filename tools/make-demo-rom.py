#!/usr/bin/env python3
"""
Build a tiny homebrew GBA ROM used as the built-in demo and as an automated
test fixture. It is hand-written ARM assembly, assembled with Keystone.

Graphics: mode 3 (240x160, 15-bit), dark blue background, a bouncing red/blue
ball and a green cursor controlled by the D-pad. A cycles the ball colour,
Start resets the positions.

Usage: python3 tools/make-demo-rom.py [out.gba]
"""
import sys
from pathlib import Path

from keystone import KS_ARCH_ARM, KS_MODE_ARM, Ks

CODE_ADDR = 0x080000C0

ASM = """
    mov r10, #0x04000000      @ IO base
    mov r0, #0x400            @ DISPCNT high bits
    add r0, r0, #3            @ mode 3
    str r0, [r10]             @ mode 3 + BG2

    @ Fill VRAM with dark blue
    mov r1, #0x06000000
    mov r2, #0x7800
    mov r3, #0
    mov r0, #0x12C00
bg_fill:
    strh r2, [r1, r3]
    add r3, r3, #2
    cmp r3, r0
    bne bg_fill

    @ Leave a marker in SRAM on first boot (also exercises battery saves).
    mov r0, #0x0E000000
    ldrb r1, [r0]
    cmp r1, #0xFF
    bne sram_done
    mov r1, #0x42
    strb r1, [r0]
sram_done:

    @ Initial state
    mov r3, #0x03000000
    mov r4, #100              @ ball x
    mov r5, #70               @ ball y
    mov r6, #2                @ ball dx
    mov r7, #1                @ ball dy
    mov r8, #112              @ cursor x
    mov r9, #72               @ cursor y
    mov r11, #0               @ ball colour index
    strh r4, [r3, #0x10]
    strh r5, [r3, #0x12]
    strh r8, [r3, #0x14]
    strh r9, [r3, #0x16]
    add r1, r10, #0x130
    ldrh r0, [r1]
    strh r0, [r3]             @ previous key state

frame:
    @ wait for the start of VBlank
wait_vblank:
    ldrh r0, [r10, #6]
    cmp r0, #160
    bne wait_vblank

    add r1, r10, #0x130
    ldrh r0, [r1]             @ active-low key state
    mov r3, #0x03000000
    ldrh r2, [r3]             @ previous key state

    @ A: cycle ball colour on press edge
    and r1, r0, #1
    and r12, r2, #1
    cmp r1, r12
    beq a_done
    cmp r1, #0
    bne a_done
    add r11, r11, #1
    cmp r11, #4
    moveq r11, #0
a_done:

    @ D-pad moves the cursor
    tst r0, #0x10
    addeq r8, r8, #2
    tst r0, #0x20
    subeq r8, r8, #2
    tst r0, #0x40
    subeq r9, r9, #2
    tst r0, #0x80
    addeq r9, r9, #2

    cmp r8, #0
    movlt r8, #0
    cmp r8, #224
    movgt r8, #224
    cmp r9, #0
    movlt r9, #0
    cmp r9, #144
    movgt r9, #144

    @ Start: reset positions
    tst r0, #0x8
    bne no_start
    mov r4, #100
    mov r5, #70
    mov r8, #112
    mov r9, #72
no_start:

    strh r0, [r3]             @ remember key state

    @ Move ball and bounce off the edges
    add r4, r4, r6
    add r5, r5, r7

    cmp r4, #0
    bge ball_x_ok
    mov r4, #0
    neg r6, r6
ball_x_ok:
    cmp r4, #224
    ble ball_x_ok2
    mov r4, #224
    neg r6, r6
ball_x_ok2:
    cmp r5, #0
    bge ball_y_ok
    mov r5, #0
    neg r7, r7
ball_y_ok:
    cmp r5, #144
    ble ball_y_ok2
    mov r5, #144
    neg r7, r7
ball_y_ok2:

    @ Erase previous ball and cursor
    mov r3, #0x03000000
    ldrh r0, [r3, #0x10]
    ldrh r1, [r3, #0x12]
    mov r2, #16
    mov r3, #0x7800
    bl fill_rect

    mov r3, #0x03000000
    ldrh r0, [r3, #0x14]
    ldrh r1, [r3, #0x16]
    mov r2, #16
    mov r3, #0x7800
    bl fill_rect

    @ Draw cursor
    mov r0, r8
    mov r1, r9
    mov r2, #16
    mov r3, #0x03E0
    bl fill_rect

    @ Draw ball (colour depends on r11)
    mov r0, r4
    mov r1, r5
    mov r2, #16
    mov r3, #0x001F
    orr r3, r3, r11, lsl #10
    orr r3, r3, r11, lsl #5
    bl fill_rect

    @ Remember positions for the next frame
    mov r3, #0x03000000
    strh r4, [r3, #0x10]
    strh r5, [r3, #0x12]
    strh r8, [r3, #0x14]
    strh r9, [r3, #0x16]

    b frame

@ fill_rect(x=r0, y=r1, size=r2, colour=r3)
fill_rect:
    push {r4-r7, lr}
    mov r4, #0x06000000
    mov r5, #240
    mul r5, r1, r5
    add r5, r5, r0
    add r5, r5, r5
    add r4, r4, r5            @ destination pointer
    mov r5, r2                @ rows left
    mov r7, #240
    sub r7, r7, r2
    add r7, r7, r7            @ bytes to skip after each row
row_loop:
    mov r12, r2               @ columns left
col_loop:
    strh r3, [r4], #2
    subs r12, r12, #1
    bne col_loop
    add r4, r4, r7
    subs r5, r5, #1
    bne row_loop
    pop {r4-r7, pc}
"""


def build(out_path: Path) -> None:
    ks = Ks(KS_ARCH_ARM, KS_MODE_ARM)
    code, _ = ks.asm(ASM, CODE_ADDR)
    if not code:
        raise SystemExit("assembly failed")

    rom = bytearray(0x8000)
    rom[0xC0 : 0xC0 + len(code)] = bytes(code)

    # ARM branch to 0x080000C0: (target - pc - 8) / 4
    rom[0:4] = (0xEA000000 | (((CODE_ADDR - 0x08000000 - 8) // 4) & 0xFFFFFF)).to_bytes(4, "little")

    def put(offset: int, data: bytes) -> None:
        rom[offset : offset + len(data)] = data

    put(0xA0, b"GBA WEB DEMO")
    put(0xAC, b"GWEB")
    put(0xB0, b"01")
    rom[0xB2] = 0x96  # fixed value in a valid header
    rom[0xBC] = 0x00  # version
    # Header complement check.
    checksum = (-(0x19 + sum(rom[0xA0:0xBD]))) & 0xFF
    rom[0xBD] = checksum

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(rom)
    print(f"wrote {out_path} ({len(rom)} bytes, {len(code)} bytes of code)")


if __name__ == "__main__":
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "demo" / "gba-web-demo.gba"
    build(out)
