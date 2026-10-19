#!/usr/bin/env python3
"""
Build small diagnostic ROMs used by the automated tests.

  vcount.gba  - copies REG_VCOUNT to VRAM[0] forever (tests PPU + CPU + video)
  pixel.gba   - draws a moving pixel with a busy delay (tests video updates)

Usage: python3 tools/make-test-roms.py [outdir]
"""
import sys
from pathlib import Path

from keystone import KS_ARCH_ARM, KS_MODE_ARM, Ks

CODE_ADDR = 0x080000C0


def header(code: bytes, title: bytes, code_id: bytes = b"TEST") -> bytearray:
    rom = bytearray(0x8000)
    rom[0xC0 : 0xC0 + len(code)] = code
    rom[0:4] = (0xEA000000 | (((CODE_ADDR - 0x08000000 - 8) // 4) & 0xFFFFFF)).to_bytes(4, "little")
    rom[0xA0:0xAC] = title[:12].ljust(12, b" ")
    rom[0xAC : 0xB0] = code_id[:4].ljust(4, b" ")
    rom[0xB0:0xB2] = b"01"
    rom[0xB2] = 0x96
    rom[0xBD] = (-(0x19 + sum(rom[0xA0:0xBD]))) & 0xFF
    return rom


def assemble(src: str) -> bytes:
    ks = Ks(KS_ARCH_ARM, KS_MODE_ARM)
    code, _ = ks.asm(src, CODE_ADDR)
    return bytes(code)


VCOUNT_ASM = """
    mov r0, #0x04000000
    mov r1, #0x0400
    add r1, r1, #3
    str r1, [r0]            @ mode 3 + BG2
    mov r2, #0x06000000
loop:
    ldrh r3, [r0, #6]       @ REG_VCOUNT
    strh r3, [r2]           @ VRAM[0]
    ldrh r3, [r0, #6]
    add r3, r3, r3, lsl #5  @ spread the value so the colour changes visibly
    strh r3, [r2, #2]
    b loop
"""

PIXEL_ASM = """
    mov r0, #0x04000000
    mov r1, #0x0400
    add r1, r1, #3
    str r1, [r0]
    mov r2, #0x06000000

    @ clear the screen to near-black
    mov r3, #0x0842
    mov r4, #0
    mov r5, #0x12C00
clear:
    strh r3, [r2, r4]
    add r4, r4, #2
    cmp r4, r5
    bne clear

    mov r4, #0               @ x
    mov r6, #0               @ frame counter
    mov r5, #0x7C00          @ red

loop:
    @ wait for VBlank
wait:
    ldrh r3, [r0, #6]
    cmp r3, #160
    bne wait

    @ advance x, wrap at 240
    add r4, r4, #1
    cmp r4, #240
    moveq r4, #0

    @ plot (x, 80) using the current frame colour
    mov r3, #80
    mov r7, #240
    mul r3, r3, r7
    add r3, r3, r4
    add r3, r3, r3
    strh r5, [r2, r3]

    @ cycle colour every 16 frames
    add r6, r6, #1
    and r7, r6, #15
    cmp r7, #0
    bne loop
    add r5, r5, #0x0021
    lsl r5, r5, #17
    lsr r5, r5, #17
    b loop
"""


def main() -> None:
    outdir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("tests/roms")
    outdir.mkdir(parents=True, exist_ok=True)
    roms = {
        "vcount.gba": (VCOUNT_ASM, b"VCOUNT"),
        "pixel.gba": (PIXEL_ASM, b"PIXEL"),
    }
    for name, (asm, title) in roms.items():
        code = assemble(asm)
        path = outdir / name
        path.write_bytes(header(code, title))
        print(f"wrote {path} ({len(code)} bytes of code)")


if __name__ == "__main__":
    main()
