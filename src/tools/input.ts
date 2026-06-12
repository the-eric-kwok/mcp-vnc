// src/tools/input.ts
import { VncClient } from '@computernewb/nodejs-rfb';
import { VncConnectionManager } from '../vnc/client.js';
import { parseKeyInput, getKeysym, charNeedsShift, getUnshiftedChar } from '../vnc/keyboard.js';

const POINTER_BUTTONS = {
  'left': 0x01,
  'right': 0x04,
  'middle': 0x02
};

const SCROLL_BUTTONS = {
  'up': 0x08,
  'down': 0x10,
  'left': 0x20,
  'right': 0x40
};

type PointerButton = keyof typeof POINTER_BUTTONS;
type ScrollDirection = keyof typeof SCROLL_BUTTONS;

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getButtonMask(button?: string) {
  return POINTER_BUTTONS[(button || 'left') as PointerButton] || POINTER_BUTTONS.left;
}

export async function handleClick(
  vncManager: VncConnectionManager, 
  args: { x: number; y: number; button?: string; double?: boolean }
) {
  return vncManager.executeWithConnection(async (client) => {
    // Validate coordinates
    const coordValidation = vncManager.validateCoordinates(client, args.x, args.y);
    if (!coordValidation.valid) {
      throw new Error(coordValidation.error!);
    }

    const button = args.button || 'left';
    const isDouble = args.double || false;
    const buttonMask = getButtonMask(button);

    if (isDouble) {
      // Perform double-click: two quick clicks with short delay
      client.sendPointerEvent(args.x, args.y, buttonMask);
      await sleep(50);
      client.sendPointerEvent(args.x, args.y, 0);
      await sleep(50);
      client.sendPointerEvent(args.x, args.y, buttonMask);
      await sleep(50);
      client.sendPointerEvent(args.x, args.y, 0);
    } else {
      // Single click
      client.sendPointerEvent(args.x, args.y, buttonMask);
      await sleep(100);
      client.sendPointerEvent(args.x, args.y, 0);
    }

    const clickType = isDouble ? 'double-clicked' : 'clicked';
    return {
      content: [{ type: 'text', text: `${clickType} ${button} button at (${args.x}, ${args.y})` }]
    };
  });
}

export async function handleMoveMouse(
  vncManager: VncConnectionManager, 
  args: { x: number; y: number }
) {
  return vncManager.executeWithConnection(async (client) => {
    // Validate coordinates
    const coordValidation = vncManager.validateCoordinates(client, args.x, args.y);
    if (!coordValidation.valid) {
      throw new Error(coordValidation.error!);
    }

    client.sendPointerEvent(args.x, args.y, 0);

    return {
      content: [{ type: 'text', text: `Moved mouse to (${args.x}, ${args.y})` }]
    };
  });
}

export async function handleScroll(
  vncManager: VncConnectionManager,
  args: { x: number; y: number; direction?: ScrollDirection; amount?: number }
) {
  return vncManager.executeWithConnection(async (client) => {
    // Validate coordinates
    const coordValidation = vncManager.validateCoordinates(client, args.x, args.y);
    if (!coordValidation.valid) {
      throw new Error(coordValidation.error!);
    }

    // RFB represents wheel motion as pointer button events: 4-7 for up/down/left/right.
    const direction = args.direction || 'down';
    const buttonMask = SCROLL_BUTTONS[direction];
    if (buttonMask === undefined) {
      throw new Error(`Invalid scroll direction "${direction}". Use one of: up, down, left, right`);
    }

    const requestedAmount = Number.isFinite(args.amount) ? args.amount! : 3;
    const amount = Math.max(1, Math.min(Math.floor(requestedAmount), 600));

    for (let i = 0; i < amount; i++) {
      client.sendPointerEvent(args.x, args.y, buttonMask);
      await sleep(5);
      client.sendPointerEvent(args.x, args.y, 0);
      await sleep(5);
    }

    const notch = amount === 1 ? 'notch' : 'notches';
    return {
      content: [{ type: 'text', text: `Scrolled ${direction} ${amount} ${notch} at (${args.x}, ${args.y})` }]
    };
  });
}

export async function handleDrag(
  vncManager: VncConnectionManager,
  args: { startX: number; startY: number; endX: number; endY: number; button?: string; durationMs?: number; steps?: number }
) {
  return performPointerDrag(vncManager, args, 'Dragged');
}

export async function handleSwipe(
  vncManager: VncConnectionManager,
  args: { startX: number; startY: number; endX: number; endY: number; durationMs?: number; steps?: number }
) {
  return performPointerDrag(vncManager, { ...args, button: 'left' }, 'Swiped');
}

async function performPointerDrag(
  vncManager: VncConnectionManager,
  args: { startX: number; startY: number; endX: number; endY: number; button?: string; durationMs?: number; steps?: number },
  actionName: string
) {
  return vncManager.executeWithConnection(async (client) => {
    for (const [label, x, y] of [
      ['start', args.startX, args.startY],
      ['end', args.endX, args.endY]
    ] as const) {
      const coordValidation = vncManager.validateCoordinates(client, x, y);
      if (!coordValidation.valid) {
        throw new Error(`${label} coordinate invalid: ${coordValidation.error}`);
      }
    }

    const button = args.button || 'left';
    const buttonMask = getButtonMask(button);
    const durationMs = Math.max(0, Math.min(args.durationMs ?? 500, 30000));
    const steps = Math.max(1, Math.min(Math.round(args.steps ?? 20), 300));
    const stepDelay = steps > 0 ? durationMs / steps : 0;

    client.sendPointerEvent(args.startX, args.startY, 0);
    await sleep(30);
    client.sendPointerEvent(args.startX, args.startY, buttonMask);

    for (let step = 1; step <= steps; step++) {
      const progress = step / steps;
      const x = Math.round(args.startX + (args.endX - args.startX) * progress);
      const y = Math.round(args.startY + (args.endY - args.startY) * progress);
      if (stepDelay > 0) {
        await sleep(stepDelay);
      }
      client.sendPointerEvent(x, y, buttonMask);
    }

    await sleep(30);
    client.sendPointerEvent(args.endX, args.endY, 0);

    return {
      content: [{
        type: 'text',
        text: `${actionName} ${button} button from (${args.startX}, ${args.startY}) to (${args.endX}, ${args.endY}) over ${durationMs}ms in ${steps} steps`
      }]
    };
  });
}

export async function handleKeyPress(
  vncManager: VncConnectionManager, 
  args: { key: string }
) {
  return vncManager.executeWithConnection(async (client) => {
    const { modifiers, key } = parseKeyInput(args.key);
    
    if (modifiers.length === 0) {
      // Single key press
      const keysym = getKeysym(key);
      client.sendKeyEvent(keysym, true);
      await new Promise(resolve => setTimeout(resolve, 50));
      client.sendKeyEvent(keysym, false);
    } else {
      // Key combination - press modifiers first, then main key, then release in reverse order
      const modifierKeysyms = modifiers.map(mod => getKeysym(mod));
      const mainKeysym = getKeysym(key);
      
      // Press all modifier keys
      for (const modKeysym of modifierKeysyms) {
        client.sendKeyEvent(modKeysym, true);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      
      // Press main key
      client.sendKeyEvent(mainKeysym, true);
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Release main key
      client.sendKeyEvent(mainKeysym, false);
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Release modifier keys in reverse order
      for (let i = modifierKeysyms.length - 1; i >= 0; i--) {
        client.sendKeyEvent(modifierKeysyms[i], false);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }

    return {
      content: [{ type: 'text', text: `Pressed key combination: ${args.key}` }]
    };
  });
}

export async function handleTypeText(
  vncManager: VncConnectionManager, 
  args: { text: string; enter?: boolean }
) {
  return vncManager.executeWithConnection(async (client) => {
    // Single-line text input only
    await typeString(client, args.text);

    // Press Enter only if explicitly requested
    if (args.enter) {
      const enterKeysym = getKeysym('Return');
      client.sendKeyEvent(enterKeysym, true);
      await new Promise(resolve => setTimeout(resolve, 50));
      client.sendKeyEvent(enterKeysym, false);
    }

    const enterText = args.enter ? ' + Enter' : '';
    return {
      content: [{ type: 'text', text: `Typed text: ${args.text}${enterText}` }]
    };
  });
}

export async function handleTypeMultiline(
  vncManager: VncConnectionManager, 
  args: { lines: string[] }
) {
  return vncManager.executeWithConnection(async (client) => {
    // Multi-line mode: type each string as a separate line with Enter after each
    for (const line of args.lines) {
      await typeString(client, line);
      
      // Always press Enter after each line
      const enterKeysym = getKeysym('Return');
      client.sendKeyEvent(enterKeysym, true);
      await new Promise(resolve => setTimeout(resolve, 50));
      client.sendKeyEvent(enterKeysym, false);
      await new Promise(resolve => setTimeout(resolve, 100)); // Brief pause between lines
    }

    return {
      content: [{ type: 'text', text: `Typed ${args.lines.length} lines: ${args.lines.join(' | ')}` }]
    };
  });
}

async function typeString(client: any, text: string) {
  // Determine if this text needs slower typing
  const hasSpecialChars = /[|:;&<>?/\\~`!@#$%^*()+=\[\]{}'",-]/.test(text);
  const isLongText = text.length > 10;
  const useSlowTyping = hasSpecialChars || isLongText;

  // Use different timing based on text complexity
  const keyHoldTime = useSlowTyping ? 75 : 50;
  const betweenKeyDelay = useSlowTyping ? 100 : 50;

  for (const char of text) {
    await typeCharacter(client, char, keyHoldTime, betweenKeyDelay);
  }
}

async function typeCharacter(
  vncClient: VncClient, 
  char: string, 
  keyHoldTime: number, 
  betweenKeyDelay: number
) {
  // Check if this is a character that needs shift
  const needsShift = charNeedsShift(char);
  const keysym = getKeysym(needsShift ? getUnshiftedChar(char) : char);
  const shiftKeysym = getKeysym('Shift');
  
  console.error(`Typing '${char}' with keysym 0x${keysym.toString(16)}${needsShift ? ' (with Shift)' : ''}`);
  
  try {
    // Press Shift if needed
    if (needsShift) {
      vncClient.sendKeyEvent(shiftKeysym, true);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    
    // Press and release the key
    vncClient.sendKeyEvent(keysym, true);
    await new Promise(resolve => setTimeout(resolve, keyHoldTime));
    vncClient.sendKeyEvent(keysym, false);
    
    // Release Shift if it was pressed
    if (needsShift) {
      await new Promise(resolve => setTimeout(resolve, 10));
      vncClient.sendKeyEvent(shiftKeysym, false);
    }
    
    await new Promise(resolve => setTimeout(resolve, betweenKeyDelay));
  } catch (error) {
    console.error(`VNC library error typing character '${char}':`, error);
    // Rethrow to fail the entire text operation and allow client retry
    throw new Error(`VNC buffer error typing character '${char}'. This may be a temporary issue - please retry the operation.`);
  }
}
