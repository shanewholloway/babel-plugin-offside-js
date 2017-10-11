'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.hookBabylon = hookBabylon;
exports.installOffsideBabylonParsers = installOffsideBabylonParsers;
exports.asOffsideJSBabylonParser = asOffsideJSBabylonParser;

var _offside_ops = require('./offside_ops');

function hookBabylon(babylon) {
  // abuse Babylon token updateContext callback extract
  // the reference to Parser

  let Parser;
  const tgt_patch = babylon.tokTypes.braceL;
  const fn_updateContext = tgt_patch.updateContext;
  tgt_patch.updateContext = function (prevType) {
    tgt_patch.updateContext = fn_updateContext;
    Parser = this.constructor;
  };

  babylon.parse('{}');
  if (!Parser) {
    throw new Error("Failed to hook Babylon Parser");
  }
  return Parser;
}function installOffsideBabylonParsers() {
  const hookList = [];

  try {
    hookList.push(require('babylon'));
  } catch (err) {}

  try {
    hookList.push(require('babel-cli/node_modules/babylon'));
  } catch (err) {}

  try {
    hookList.push(require('babel-core/node_modules/babylon'));
  } catch (err) {}

  if (0 === hookList.length) {
    throw new Error(`Unable to load "babylon" parser package`);
  }

  return hookList.map(babylon => asOffsideJSBabylonParser(babylon));
}function asOffsideJSBabylonParser(babylon) {
  // begin per-babylon instance monkeypatching

  const Parser = hookBabylon(babylon);
  const baseProto = Parser.prototype;
  const pp = Parser.prototype = Object.create(baseProto);
  const tt = babylon.tokTypes;

  const at_offside = (0, _offside_ops.offsideOperatorsForBabylon)(tt);

  var _g_offsidePluginOpts;

  const _base_module_parse = babylon.parse;
  babylon.parse = (input, options) => {
    _g_offsidePluginOpts = options ? options.offsidePluginOpts : undefined;
    return _base_module_parse(input, options);
  };

  pp._base_parse = baseProto.parse;
  pp.parse = function () {
    this.initOffside();
    return this._base_parse();
  };

  class OffsideBreakout extends Error {}
  const offsideBreakout = new OffsideBreakout();

  pp.initOffside = function () {
    this.state.offside = [];
    this.state.offsideNextOp = null;
    this.offside_lines = (0, _offside_ops.parseOffsideIndexMap)(this.input);
    this.offsidePluginOpts = _g_offsidePluginOpts || {};
    _g_offsidePluginOpts = null;

    this.state._pos = this.state.pos;
    Object.defineProperty(this.state, 'pos', {
      enumerable: true,
      get() {
        return this._pos;
      },
      set(pos) {
        // interrupt skipSpace algorithm when we hit our position 'breakpoint'
        const offPos = this.offsidePos;
        if (offPos >= 0 && pos > offPos) {
          throw offsideBreakout;
        }

        this._pos = pos;
      } });
  };

  const tt_offside_keyword_with_args = new Set([tt._if, tt._while, tt._for, tt._catch, tt._switch]);

  const tt_offside_keyword_lookahead_skip = new Set([tt.parenL, tt.colon, tt.comma, tt.dot]);

  pp.isForAwait = function (keywordType, type, val) {
    return tt._for === keywordType && tt.name === type && 'await' === val;
  };

  const rx_offside_op = /(\S+)[ \t]*(\r\n|\r|\n)?/;

  pp._base_finishToken = baseProto.finishToken;
  pp.finishToken = function (type, val) {
    const state = this.state;
    const recentKeyword = state.offsideRecentKeyword;
    const inForAwait = recentKeyword ? this.isForAwait(recentKeyword, type, val) : null;
    state.offsideRecentKeyword = null;

    if (tt_offside_keyword_with_args.has(type) || inForAwait) {
      const isKeywordAllowed = !this.isLookahead && tt.dot !== state.type;

      if (!isKeywordAllowed) {
        return this._base_finishToken(type, val);
      }

      state.offsideRecentKeyword = inForAwait ? tt._for : type;
      const lookahead = this.lookahead();

      if (tt_offside_keyword_lookahead_skip.has(lookahead.type)) {} else if (this.isForAwait(type, lookahead.type, lookahead.value)) {} else {
        state.offsideNextOp = at_offside.keyword_args;
      }

      return this._base_finishToken(type, val);
    }

    if (type === tt.at || type === tt.doubleColon) {
      const pos0 = state.start,
            pos1 = state.pos + 2;
      const m_op = rx_offside_op.exec(this.input.slice(pos0));
      const str_op = m_op[1];
      const lineEndsWithOp = !!m_op[2];

      let op = at_offside[str_op];
      if (op) {
        if (op.keywordBlock && recentKeyword && tt_offside_keyword_with_args.has(recentKeyword)) {
          op = at_offside.keyword_args;
        } else if (lineEndsWithOp && op.nestInner) {
          // all offside operators at the end of a line implicitly don't nestInner
          op = { __proto__: op, nestInner: false };
        }

        this.finishOffsideOp(op, op.extraChars);

        if (op.nestOp) {
          state.offsideNextOp = at_offside[op.nestOp];
        }
        return;
      }
    }

    if (tt.eof === type) {
      if (state.offside.length) {
        return this.popOffside();
      }
    }

    return this._base_finishToken(type, val);
  };

  pp.offsideIndent = function (line0, outerIndent, innerIndent) {
    const offside_lines = this.offside_lines;

    if (null == innerIndent) {
      const innerLine = offside_lines[line0 + 1];
      innerIndent = innerLine ? innerLine.indent : '';
    }

    let line = line0 + 1,
        last = offside_lines[line0];
    while (line < offside_lines.length) {
      const cur = offside_lines[line];
      if (cur.content && outerIndent >= cur.indent) {
        line--; // backup to previous line
        break;
      }

      line++;last = cur;
      if (innerIndent > cur.indent) {
        innerIndent = cur.indent;
      }
    }

    return { line, last, innerIndent };
  };

  pp.offsideBlock = function (op, stackTop, recentKeywordTop) {
    const state = this.state;
    const line0 = state.curLine;
    const first = this.offside_lines[line0];

    let indent, keywordNestedIndent;
    if (recentKeywordTop) {
      indent = recentKeywordTop.first.indent;
    } else if (op.nestInner && stackTop && line0 === stackTop.first.line) {
      indent = stackTop.innerIndent;
    } else if (op.inKeywordArg) {
      indent = first.indent;
      const indent_block = this.offsideIndent(line0, indent);
      const indent_keyword = this.offsideIndent(line0, indent_block.innerIndent);
      if (indent_keyword.innerIndent > indent_block.innerIndent) {
        // autodetect keyword argument using '@' for function calls
        indent = indent_block.innerIndent;
        keywordNestedIndent = indent_keyword.innerIndent;
      }
    } else {
      indent = first.indent;
    }

    let { last, innerIndent } = this.offsideIndent(line0, indent, keywordNestedIndent);

    // cap to 
    innerIndent = first.indent > innerIndent ? first.indent : innerIndent;

    if (stackTop && stackTop.last.posLastContent < last.posLastContent) {
      // Fixup enclosing scopes. Happens in situations like: `server.on @ wraper @ (...args) => ::`
      const stack = state.offside;
      for (let idx = stack.length - 1; idx > 0; idx--) {
        let tip = stack[idx];
        if (tip.last.posLastContent >= last.posLastContent) {
          break;
        }
        tip.last = last;
      }
    }

    return { op, innerIndent, first, last,
      start: state.start, end: state.end,
      loc: { start: state.startLoc, end: state.endLoc } };
  };

  pp.finishOffsideOp = function (op, extraChars) {
    const stack = this.state.offside;
    let stackTop = stack[stack.length - 1];
    let recentKeywordTop;
    if (op.codeBlock) {
      if (stackTop && stackTop.inKeywordArg) {
        // We're at the end of an offside keyword block; restore enclosing ()
        this.popOffside();
        this.state.offsideNextOp = op;
        this.state.offsideRecentTop = stackTop;
        return;
      }

      recentKeywordTop = this.state.offsideRecentTop;
      this.state.offsideRecentTop = null;
    }

    if (extraChars) {
      this.state.pos += extraChars;
    }

    this._base_finishToken(op.tokenPre);

    if (this.isLookahead) {
      return;
    }

    stackTop = stack[stack.length - 1];
    const blk = this.offsideBlock(op, stackTop, recentKeywordTop);
    blk.inKeywordArg = op.inKeywordArg || stackTop && stackTop.inKeywordArg;
    this.state.offside.push(blk);
  };

  pp._base_skipSpace = baseProto.skipSpace;
  pp.skipSpace = function () {
    const state = this.state;
    if (null !== state.offsideNextOp) {
      return;
    }

    const stack = state.offside;
    let stackTop;
    if (stack && stack.length) {
      stackTop = stack[stack.length - 1];
      state.offsidePos = stackTop.last.posLastContent;
    } else {
      state.offsidePos = -1;
    }

    try {
      this._base_skipSpace();
      state.offsidePos = -1;

      state.offsideImplicitComma = undefined !== stackTop ? this.offsideCheckImplicitComma(stackTop) : null;
    } catch (err) {
      if (err !== offsideBreakout) {
        throw err;
      }
    }
  };

  const tt_offside_disrupt_implicit_comma = new Set([tt.comma, tt.dot, tt.arrow]);

  pp.offsideCheckImplicitComma = function (stackTop) {
    if (!stackTop.op.implicitCommas || !this.offsidePluginOpts.implicit_commas) {
      return null; // not enabled for this offside op
    }const state = this.state,
          state_type = state.type,
          column = state.pos - state.lineStart;
    if (column !== stackTop.innerIndent.length) {
      return null; // not at the exact right indent
    }if (stackTop.end >= state.end) {
      return false; // no comma before the first element
    }if (tt.comma === state_type) {
      return false; // there's an explicit comma already present
    }if (state_type.binop || state_type.beforeExpr) {
      return false; // there's an operator or arrow function preceeding this line
    }if (this.isLookahead) {
      return false; // disallow recursive lookahead
    }const { type: next_type } = this.lookahead();
    if (tt_offside_disrupt_implicit_comma.has(next_type) || next_type.binop) {
      return false; // there's a comma, dot, operator, or other token that precludes an implicit leading comma
    }return true; // an implicit comma is needed
  };pp._base_readToken = baseProto.readToken;
  pp.readToken = function (code) {
    const state = this.state;

    if (state.offsideImplicitComma) {
      return this._base_finishToken(tt.comma);
    }

    const offsideNextOp = state.offsideNextOp;
    if (null !== offsideNextOp) {
      state.offsideNextOp = null;
      return this.finishOffsideOp(offsideNextOp);
    }

    if (state.pos === state.offsidePos) {
      return this.popOffside();
    }

    return this._base_readToken(code);
  };

  pp.popOffside = function () {
    const stack = this.state.offside;
    const stackTop = this.isLookahead ? stack[stack.length - 1] : stack.pop();
    this.state.offsidePos = -1;

    this._base_finishToken(stackTop.op.tokenPost);
    return stackTop;
  };

  return Parser;
} // end per-babylon instance monkeypatching
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL2NvZGUvcGFyc2VyLmpzIl0sIm5hbWVzIjpbImhvb2tCYWJ5bG9uIiwiaW5zdGFsbE9mZnNpZGVCYWJ5bG9uUGFyc2VycyIsImFzT2Zmc2lkZUpTQmFieWxvblBhcnNlciIsImJhYnlsb24iLCJQYXJzZXIiLCJ0Z3RfcGF0Y2giLCJ0b2tUeXBlcyIsImJyYWNlTCIsImZuX3VwZGF0ZUNvbnRleHQiLCJ1cGRhdGVDb250ZXh0IiwicHJldlR5cGUiLCJjb25zdHJ1Y3RvciIsInBhcnNlIiwiRXJyb3IiLCJob29rTGlzdCIsInB1c2giLCJyZXF1aXJlIiwiZXJyIiwibGVuZ3RoIiwibWFwIiwiYmFzZVByb3RvIiwicHJvdG90eXBlIiwicHAiLCJPYmplY3QiLCJjcmVhdGUiLCJ0dCIsImF0X29mZnNpZGUiLCJfZ19vZmZzaWRlUGx1Z2luT3B0cyIsIl9iYXNlX21vZHVsZV9wYXJzZSIsImlucHV0Iiwib3B0aW9ucyIsIm9mZnNpZGVQbHVnaW5PcHRzIiwidW5kZWZpbmVkIiwiX2Jhc2VfcGFyc2UiLCJpbml0T2Zmc2lkZSIsIk9mZnNpZGVCcmVha291dCIsIm9mZnNpZGVCcmVha291dCIsInN0YXRlIiwib2Zmc2lkZSIsIm9mZnNpZGVOZXh0T3AiLCJvZmZzaWRlX2xpbmVzIiwiX3BvcyIsInBvcyIsImRlZmluZVByb3BlcnR5IiwiZW51bWVyYWJsZSIsImdldCIsInNldCIsIm9mZlBvcyIsIm9mZnNpZGVQb3MiLCJ0dF9vZmZzaWRlX2tleXdvcmRfd2l0aF9hcmdzIiwiU2V0IiwiX2lmIiwiX3doaWxlIiwiX2ZvciIsIl9jYXRjaCIsIl9zd2l0Y2giLCJ0dF9vZmZzaWRlX2tleXdvcmRfbG9va2FoZWFkX3NraXAiLCJwYXJlbkwiLCJjb2xvbiIsImNvbW1hIiwiZG90IiwiaXNGb3JBd2FpdCIsImtleXdvcmRUeXBlIiwidHlwZSIsInZhbCIsIm5hbWUiLCJyeF9vZmZzaWRlX29wIiwiX2Jhc2VfZmluaXNoVG9rZW4iLCJmaW5pc2hUb2tlbiIsInJlY2VudEtleXdvcmQiLCJvZmZzaWRlUmVjZW50S2V5d29yZCIsImluRm9yQXdhaXQiLCJoYXMiLCJpc0tleXdvcmRBbGxvd2VkIiwiaXNMb29rYWhlYWQiLCJsb29rYWhlYWQiLCJ2YWx1ZSIsImtleXdvcmRfYXJncyIsImF0IiwiZG91YmxlQ29sb24iLCJwb3MwIiwic3RhcnQiLCJwb3MxIiwibV9vcCIsImV4ZWMiLCJzbGljZSIsInN0cl9vcCIsImxpbmVFbmRzV2l0aE9wIiwib3AiLCJrZXl3b3JkQmxvY2siLCJuZXN0SW5uZXIiLCJfX3Byb3RvX18iLCJmaW5pc2hPZmZzaWRlT3AiLCJleHRyYUNoYXJzIiwibmVzdE9wIiwiZW9mIiwicG9wT2Zmc2lkZSIsIm9mZnNpZGVJbmRlbnQiLCJsaW5lMCIsIm91dGVySW5kZW50IiwiaW5uZXJJbmRlbnQiLCJpbm5lckxpbmUiLCJpbmRlbnQiLCJsaW5lIiwibGFzdCIsImN1ciIsImNvbnRlbnQiLCJvZmZzaWRlQmxvY2siLCJzdGFja1RvcCIsInJlY2VudEtleXdvcmRUb3AiLCJjdXJMaW5lIiwiZmlyc3QiLCJrZXl3b3JkTmVzdGVkSW5kZW50IiwiaW5LZXl3b3JkQXJnIiwiaW5kZW50X2Jsb2NrIiwiaW5kZW50X2tleXdvcmQiLCJwb3NMYXN0Q29udGVudCIsInN0YWNrIiwiaWR4IiwidGlwIiwiZW5kIiwibG9jIiwic3RhcnRMb2MiLCJlbmRMb2MiLCJjb2RlQmxvY2siLCJvZmZzaWRlUmVjZW50VG9wIiwidG9rZW5QcmUiLCJibGsiLCJfYmFzZV9za2lwU3BhY2UiLCJza2lwU3BhY2UiLCJvZmZzaWRlSW1wbGljaXRDb21tYSIsIm9mZnNpZGVDaGVja0ltcGxpY2l0Q29tbWEiLCJ0dF9vZmZzaWRlX2Rpc3J1cHRfaW1wbGljaXRfY29tbWEiLCJhcnJvdyIsImltcGxpY2l0Q29tbWFzIiwiaW1wbGljaXRfY29tbWFzIiwic3RhdGVfdHlwZSIsImNvbHVtbiIsImxpbmVTdGFydCIsImJpbm9wIiwiYmVmb3JlRXhwciIsIm5leHRfdHlwZSIsIl9iYXNlX3Jl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LEtBQUtBLEtBQW5COztBQUVBLFFBQUdBLE1BQU02RixvQkFBVCxFQUFnQztBQUM5QixhQUFPLEtBQUsvRCxpQkFBTCxDQUF1QjFDLEdBQUdrQyxLQUExQixDQUFQO0FBQXVDOztBQUV6QyxVQUFNcEIsZ0JBQWdCRixNQUFNRSxhQUE1QjtBQUNBLFFBQUcsU0FBU0EsYUFBWixFQUE0QjtBQUMxQkYsWUFBTUUsYUFBTixHQUFzQixJQUF0QjtBQUNBLGFBQU8sS0FBS3FELGVBQUwsQ0FBcUJyRCxhQUFyQixDQUFQO0FBQTBDOztBQUU1QyxRQUFHRixNQUFNSyxHQUFOLEtBQWNMLE1BQU1XLFVBQXZCLEVBQW9DO0FBQ2xDLGFBQU8sS0FBS2dELFVBQUwsRUFBUDtBQUF3Qjs7QUFFMUIsV0FBTyxLQUFLOEMsZUFBTCxDQUFxQkUsSUFBckIsQ0FBUDtBQUFpQyxHQWRuQzs7QUFnQkExSCxLQUFHMEUsVUFBSCxHQUFnQixZQUFXO0FBQ3pCLFVBQU1xQixRQUFRLEtBQUtoRixLQUFMLENBQVdDLE9BQXpCO0FBQ0EsVUFBTXNFLFdBQVcsS0FBS2xDLFdBQUwsR0FDYjJDLE1BQU1BLE1BQU1uRyxNQUFOLEdBQWEsQ0FBbkIsQ0FEYSxHQUVibUcsTUFBTTRCLEdBQU4sRUFGSjtBQUdBLFNBQUs1RyxLQUFMLENBQVdXLFVBQVgsR0FBd0IsQ0FBQyxDQUF6Qjs7QUFFQSxTQUFLbUIsaUJBQUwsQ0FBdUJ5QyxTQUFTcEIsRUFBVCxDQUFZMEQsU0FBbkM7QUFDQSxXQUFPdEMsUUFBUDtBQUFlLEdBUmpCOztBQVdBLFNBQU94RyxNQUFQO0FBQ0MsQyxDQUFDIiwiZmlsZSI6InBhcnNlci5qcyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7b2Zmc2lkZU9wZXJhdG9yc0ZvckJhYnlsb24sIHBhcnNlT2Zmc2lkZUluZGV4TWFwfSBmcm9tICcuL29mZnNpZGVfb3BzJ1xuXG5leHBvcnQgZnVuY3Rpb24gaG9va0JhYnlsb24oYmFieWxvbikgOjpcbiAgLy8gYWJ1c2UgQmFieWxvbiB0b2tlbiB1cGRhdGVDb250ZXh0IGNhbGxiYWNrIGV4dHJhY3RcbiAgLy8gdGhlIHJlZmVyZW5jZSB0byBQYXJzZXJcblxuICBsZXQgUGFyc2VyXG4gIGNvbnN0IHRndF9wYXRjaCA9IGJhYnlsb24udG9rVHlwZXMuYnJhY2VMXG4gIGNvbnN0IGZuX3VwZGF0ZUNvbnRleHQgPSB0Z3RfcGF0Y2gudXBkYXRlQ29udGV4dFxuICB0Z3RfcGF0Y2gudXBkYXRlQ29udGV4dCA9IGZ1bmN0aW9uIChwcmV2VHlwZSkgOjpcbiAgICB0Z3RfcGF0Y2gudXBkYXRlQ29udGV4dCA9IGZuX3VwZGF0ZUNvbnRleHRcbiAgICBQYXJzZXIgPSB0aGlzLmNvbnN0cnVjdG9yXG5cbiAgYmFieWxvbi5wYXJzZSgne30nKVxuICBpZiAhIFBhcnNlciA6OlxuICAgIHRocm93IG5ldyBFcnJvciBAIFwiRmFpbGVkIHRvIGhvb2sgQmFieWxvbiBQYXJzZXJcIlxuICByZXR1cm4gUGFyc2VyXG5cblxuZXhwb3J0IGZ1bmN0aW9uIGluc3RhbGxPZmZzaWRlQmFieWxvblBhcnNlcnMoKSA6OlxuICBjb25zdCBob29rTGlzdCA9IFtdXG5cbiAgdHJ5IDo6IGhvb2tMaXN0LnB1c2ggQFxuICAgIHJlcXVpcmUoJ2JhYnlsb24nKVxuICBjYXRjaCBlcnIgOjpcblxuICB0cnkgOjogaG9va0xpc3QucHVzaCBAXG4gICAgcmVxdWlyZSgnYmFiZWwtY2xpL25vZGVfbW9kdWxlcy9iYWJ5bG9uJylcbiAgY2F0Y2ggZXJyIDo6XG5cbiAgdHJ5IDo6IGhvb2tMaXN0LnB1c2ggQFxuICAgIHJlcXVpcmUoJ2JhYmVsLWNvcmUvbm9kZV9tb2R1bGVzL2JhYnlsb24nKVxuICBjYXRjaCBlcnIgOjpcblxuICBpZiAwID09PSBob29rTGlzdC5sZW5ndGggOjpcbiAgICB0aHJvdyBuZXcgRXJyb3IgQCBgVW5hYmxlIHRvIGxvYWQgXCJiYWJ5bG9uXCIgcGFyc2VyIHBhY2thZ2VgXG5cbiAgcmV0dXJuIGhvb2tMaXN0Lm1hcCBAIGJhYnlsb24gPT5cbiAgICBhc09mZnNpZGVKU0JhYnlsb25QYXJzZXIoYmFieWxvbilcbiAgXG5cbmV4cG9ydCBmdW5jdGlvbiBhc09mZnNpZGVKU0JhYnlsb25QYXJzZXIoYmFieWxvbilcbnsgLy8gYmVnaW4gcGVyLWJhYnlsb24gaW5zdGFuY2UgbW9ua2V5cGF0Y2hpbmdcblxuY29uc3QgUGFyc2VyID0gaG9va0JhYnlsb24oYmFieWxvbilcbmNvbnN0IGJhc2VQcm90byA9IFBhcnNlci5wcm90b3R5cGVcbmNvbnN0IHBwID0gUGFyc2VyLnByb3RvdHlwZSA9IE9iamVjdC5jcmVhdGUoYmFzZVByb3RvKVxuY29uc3QgdHQgPSBiYWJ5bG9uLnRva1R5cGVzXG5cbmNvbnN0IGF0X29mZnNpZGUgPSBvZmZzaWRlT3BlcmF0b3JzRm9yQmFieWxvbih0dClcblxudmFyIF9nX29mZnNpZGVQbHVnaW5PcHRzXG5cbmNvbnN0IF9iYXNlX21vZHVsZV9wYXJzZSA9IGJhYnlsb24ucGFyc2VcbmJhYnlsb24ucGFyc2UgPSAoaW5wdXQsIG9wdGlvbnMpID0+IDo6XG4gIF9nX29mZnNpZGVQbHVnaW5PcHRzID0gb3B0aW9ucyA/IG9wdGlvbnMub2Zmc2lkZVBsdWdpbk9wdHMgOiB1bmRlZmluZWRcbiAgcmV0dXJuIF9iYXNlX21vZHVsZV9wYXJzZShpbnB1dCwgb3B0aW9ucylcblxuXG5wcC5fYmFzZV9wYXJzZSA9IGJhc2VQcm90by5wYXJzZVxucHAucGFyc2UgPSBmdW5jdGlvbigpIDo6XG4gIHRoaXMuaW5pdE9mZnNpZGUoKVxuICByZXR1cm4gdGhpcy5fYmFzZV9wYXJzZSgpXG5cblxuY2xhc3MgT2Zmc2lkZUJyZWFrb3V0IGV4dGVuZHMgRXJyb3Ige31cbmNvbnN0IG9mZnNpZGVCcmVha291dCA9IG5ldyBPZmZzaWRlQnJlYWtvdXQoKVxuXG5wcC5pbml0T2Zmc2lkZSA9IGZ1bmN0aW9uKCkgOjpcbiAgdGhpcy5zdGF0ZS5vZmZzaWRlID0gW11cbiAgdGhpcy5zdGF0ZS5vZmZzaWRlTmV4dE9wID0gbnVsbFxuICB0aGlzLm9mZnNpZGVfbGluZXMgPSBwYXJzZU9mZnNpZGVJbmRleE1hcCh0aGlzLmlucHV0KVxuICB0aGlzLm9mZnNpZGVQbHVnaW5PcHRzID0gX2dfb2Zmc2lkZVBsdWdpbk9wdHMgfHwge31cbiAgX2dfb2Zmc2lkZVBsdWdpbk9wdHMgPSBudWxsXG5cbiAgdGhpcy5zdGF0ZS5fcG9zID0gdGhpcy5zdGF0ZS5wb3NcbiAgT2JqZWN0LmRlZmluZVByb3BlcnR5IEAgdGhpcy5zdGF0ZSwgJ3BvcycsIEA6XG4gICAgZW51bWVyYWJsZTogdHJ1ZVxuICAgIGdldCgpIDo6IHJldHVybiB0aGlzLl9wb3NcbiAgICBzZXQocG9zKSA6OlxuICAgICAgLy8gaW50ZXJydXB0IHNraXBTcGFjZSBhbGdvcml0aG0gd2hlbiB3ZSBoaXQgb3VyIHBvc2l0aW9uICdicmVha3BvaW50J1xuICAgICAgY29uc3Qgb2ZmUG9zID0gdGhpcy5vZmZzaWRlUG9zXG4gICAgICBpZiBvZmZQb3M+PTAgJiYgKHBvcyA+IG9mZlBvcykgOjpcbiAgICAgICAgdGhyb3cgb2Zmc2lkZUJyZWFrb3V0XG5cbiAgICAgIHRoaXMuX3BvcyA9IHBvc1xuXG5cbmNvbnN0IHR0X29mZnNpZGVfa2V5d29yZF93aXRoX2FyZ3MgPSBuZXcgU2V0IEAjXG4gIHR0Ll9pZiwgdHQuX3doaWxlLCB0dC5fZm9yXG4gIHR0Ll9jYXRjaCwgdHQuX3N3aXRjaFxuXG5jb25zdCB0dF9vZmZzaWRlX2tleXdvcmRfbG9va2FoZWFkX3NraXAgPSBuZXcgU2V0IEAjXG4gIHR0LnBhcmVuTCwgdHQuY29sb24sIHR0LmNvbW1hLCB0dC5kb3RcblxucHAuaXNGb3JBd2FpdCA9IGZ1bmN0aW9uIChrZXl3b3JkVHlwZSwgdHlwZSwgdmFsKSA6OlxuICByZXR1cm4gdHQuX2ZvciA9PT0ga2V5d29yZFR5cGVcbiAgICAmJiB0dC5uYW1lID09PSB0eXBlXG4gICAgJiYgJ2F3YWl0JyA9PT0gdmFsXG5cbmNvbnN0IHJ4X29mZnNpZGVfb3AgPSAvKFxcUyspWyBcXHRdKihcXHJcXG58XFxyfFxcbik/L1xuXG5wcC5fYmFzZV9maW5pc2hUb2tlbiA9IGJhc2VQcm90by5maW5pc2hUb2tlblxucHAuZmluaXNoVG9rZW4gPSBmdW5jdGlvbih0eXBlLCB2YWwpIDo6XG4gIGNvbnN0IHN0YXRlID0gdGhpcy5zdGF0ZVxuICBjb25zdCByZWNlbnRLZXl3b3JkID0gc3RhdGUub2Zmc2lkZVJlY2VudEtleXdvcmRcbiAgY29uc3QgaW5Gb3JBd2FpdCA9IHJlY2VudEtleXdvcmQgPyB0aGlzLmlzRm9yQXdhaXQocmVjZW50S2V5d29yZCwgdHlwZSwgdmFsKSA6IG51bGxcbiAgc3RhdGUub2Zmc2lkZVJlY2VudEtleXdvcmQgPSBudWxsXG5cbiAgaWYgdHRfb2Zmc2lkZV9rZXl3b3JkX3dpdGhfYXJncy5oYXModHlwZSkgfHwgaW5Gb3JBd2FpdCA6OlxuICAgIGNvbnN0IGlzS2V5d29yZEFsbG93ZWQgPSAhdGhpcy5pc0xvb2thaGVhZFxuICAgICAgJiYgdHQuZG90ICE9PSBzdGF0ZS50eXBlXG5cbiAgICBpZiAhaXNLZXl3b3JkQWxsb3dlZCA6OlxuICAgICAgcmV0dXJuIHRoaXMuX2Jhc2VfZmluaXNoVG9rZW4odHlwZSwgdmFsKVxuXG4gICAgc3RhdGUub2Zmc2lkZVJlY2VudEtleXdvcmQgPSBpbkZvckF3YWl0ID8gdHQuX2ZvciA6IHR5cGVcbiAgICBjb25zdCBsb29rYWhlYWQgPSB0aGlzLmxvb2thaGVhZCgpXG5cbiAgICBpZiB0dF9vZmZzaWRlX2tleXdvcmRfbG9va2FoZWFkX3NraXAuaGFzKGxvb2thaGVhZC50eXBlKSA6OlxuICAgIGVsc2UgaWYgdGhpcy5pc0ZvckF3YWl0KHR5cGUsIGxvb2thaGVhZC50eXBlLCBsb29rYWhlYWQudmFsdWUpIDo6XG4gICAgZWxzZSA6OlxuICAgICAgc3RhdGUub2Zmc2lkZU5leHRPcCA9IGF0X29mZnNpZGUua2V5d29yZF9hcmdzXG5cbiAgICByZXR1cm4gdGhpcy5fYmFzZV9maW5pc2hUb2tlbih0eXBlLCB2YWwpXG5cbiAgaWYgdHlwZSA9PT0gdHQuYXQgfHwgdHlwZSA9PT0gdHQuZG91YmxlQ29sb24gOjpcbiAgICBjb25zdCBwb3MwID0gc3RhdGUuc3RhcnQsIHBvczEgPSBzdGF0ZS5wb3MgKyAyXG4gICAgY29uc3QgbV9vcCA9IHJ4X29mZnNpZGVfb3AuZXhlYyBAIHRoaXMuaW5wdXQuc2xpY2UocG9zMClcbiAgICBjb25zdCBzdHJfb3AgPSBtX29wWzFdXG4gICAgY29uc3QgbGluZUVuZHNXaXRoT3AgPSAhISBtX29wWzJdXG5cbiAgICBsZXQgb3AgPSBhdF9vZmZzaWRlW3N0cl9vcF1cbiAgICBpZiBvcCA6OlxuICAgICAgaWYgb3Aua2V5d29yZEJsb2NrICYmIHJlY2VudEtleXdvcmQgJiYgdHRfb2Zmc2lkZV9rZXl3b3JkX3dpdGhfYXJncy5oYXMocmVjZW50S2V5d29yZCkgOjpcbiAgICAgICAgb3AgPSBhdF9vZmZzaWRlLmtleXdvcmRfYXJnc1xuXG4gICAgICBlbHNlIGlmIGxpbmVFbmRzV2l0aE9wICYmIG9wLm5lc3RJbm5lcjo6XG4gICAgICAgIC8vIGFsbCBvZmZzaWRlIG9wZXJhdG9ycyBhdCB0aGUgZW5kIG9mIGEgbGluZSBpbXBsaWNpdGx5IGRvbid0IG5lc3RJbm5lclxuICAgICAgICBvcCA9IEB7fSBfX3Byb3RvX186IG9wLCBuZXN0SW5uZXI6IGZhbHNlXG5cbiAgICAgIHRoaXMuZmluaXNoT2Zmc2lkZU9wKG9wLCBvcC5leHRyYUNoYXJzKVxuXG4gICAgICBpZiBvcC5uZXN0T3AgOjpcbiAgICAgICAgc3RhdGUub2Zmc2lkZU5leHRPcCA9IGF0X29mZnNpZGVbb3AubmVzdE9wXVxuICAgICAgcmV0dXJuXG5cbiAgaWYgdHQuZW9mID09PSB0eXBlIDo6XG4gICAgaWYgc3RhdGUub2Zmc2lkZS5sZW5ndGggOjpcbiAgICAgIHJldHVybiB0aGlzLnBvcE9mZnNpZGUoKVxuXG4gIHJldHVybiB0aGlzLl9iYXNlX2ZpbmlzaFRva2VuKHR5cGUsIHZhbClcblxuXG5wcC5vZmZzaWRlSW5kZW50ID0gZnVuY3Rpb24gKGxpbmUwLCBvdXRlckluZGVudCwgaW5uZXJJbmRlbnQpIDo6XG4gIGNvbnN0IG9mZnNpZGVfbGluZXMgPSB0aGlzLm9mZnNpZGVfbGluZXNcblxuICBpZiBudWxsID09IGlubmVySW5kZW50IDo6XG4gICAgY29uc3QgaW5uZXJMaW5lID0gb2Zmc2lkZV9saW5lc1tsaW5lMCsxXVxuICAgIGlubmVySW5kZW50ID0gaW5uZXJMaW5lID8gaW5uZXJMaW5lLmluZGVudCA6ICcnXG5cbiAgbGV0IGxpbmU9bGluZTArMSwgbGFzdD1vZmZzaWRlX2xpbmVzW2xpbmUwXVxuICB3aGlsZSBsaW5lIDwgb2Zmc2lkZV9saW5lcy5sZW5ndGggOjpcbiAgICBjb25zdCBjdXIgPSBvZmZzaWRlX2xpbmVzW2xpbmVdXG4gICAgaWYgY3VyLmNvbnRlbnQgJiYgb3V0ZXJJbmRlbnQgPj0gY3VyLmluZGVudCA6OlxuICAgICAgbGluZS0tIC8vIGJhY2t1cCB0byBwcmV2aW91cyBsaW5lXG4gICAgICBicmVha1xuXG4gICAgbGluZSsrOyBsYXN0ID0gY3VyXG4gICAgaWYgaW5uZXJJbmRlbnQgPiBjdXIuaW5kZW50IDo6XG4gICAgICBpbm5lckluZGVudCA9IGN1ci5pbmRlbnRcblxuICByZXR1cm4gQHt9IGxpbmUsIGxhc3QsIGlubmVySW5kZW50XG5cblxucHAub2Zmc2lkZUJsb2NrID0gZnVuY3Rpb24gKG9wLCBzdGFja1RvcCwgcmVjZW50S2V5d29yZFRvcCkgOjpcbiAgY29uc3Qgc3RhdGUgPSB0aGlzLnN0YXRlXG4gIGNvbnN0IGxpbmUwID0gc3RhdGUuY3VyTGluZVxuICBjb25zdCBmaXJzdCA9IHRoaXMub2Zmc2lkZV9saW5lc1tsaW5lMF1cblxuICBsZXQgaW5kZW50LCBrZXl3b3JkTmVzdGVkSW5kZW50XG4gIGlmIHJlY2VudEtleXdvcmRUb3AgOjpcbiAgICBpbmRlbnQgPSByZWNlbnRLZXl3b3JkVG9wLmZpcnN0LmluZGVudFxuICBlbHNlIGlmIG9wLm5lc3RJbm5lciAmJiBzdGFja1RvcCAmJiBsaW5lMCA9PT0gc3RhY2tUb3AuZmlyc3QubGluZSA6OlxuICAgIGluZGVudCA9IHN0YWNrVG9wLmlubmVySW5kZW50XG4gIGVsc2UgaWYgb3AuaW5LZXl3b3JkQXJnIDo6XG4gICAgaW5kZW50ID0gZmlyc3QuaW5kZW50XG4gICAgY29uc3QgaW5kZW50X2Jsb2NrID0gdGhpcy5vZmZzaWRlSW5kZW50KGxpbmUwLCBpbmRlbnQpXG4gICAgY29uc3QgaW5kZW50X2tleXdvcmQgPSB0aGlzLm9mZnNpZGVJbmRlbnQobGluZTAsIGluZGVudF9ibG9jay5pbm5lckluZGVudClcbiAgICBpZiBpbmRlbnRfa2V5d29yZC5pbm5lckluZGVudCA+IGluZGVudF9ibG9jay5pbm5lckluZGVudCA6OlxuICAgICAgLy8gYXV0b2RldGVjdCBrZXl3b3JkIGFyZ3VtZW50IHVzaW5nICdAJyBmb3IgZnVuY3Rpb24gY2FsbHNcbiAgICAgIGluZGVudCA9IGluZGVudF9ibG9jay5pbm5lckluZGVudFxuICAgICAga2V5d29yZE5lc3RlZEluZGVudCA9IGluZGVudF9rZXl3b3JkLmlubmVySW5kZW50XG4gIGVsc2UgOjpcbiAgICBpbmRlbnQgPSBmaXJzdC5pbmRlbnRcblxuICBsZXQge2xhc3QsIGlubmVySW5kZW50fSA9IHRoaXMub2Zmc2lkZUluZGVudChsaW5lMCwgaW5kZW50LCBrZXl3b3JkTmVzdGVkSW5kZW50KVxuXG4gIC8vIGNhcCB0byBcbiAgaW5uZXJJbmRlbnQgPSBmaXJzdC5pbmRlbnQgPiBpbm5lckluZGVudFxuICAgID8gZmlyc3QuaW5kZW50IDogaW5uZXJJbmRlbnRcblxuICBpZiBzdGFja1RvcCAmJiBzdGFja1RvcC5sYXN0LnBvc0xhc3RDb250ZW50IDwgbGFzdC5wb3NMYXN0Q29udGVudDo6XG4gICAgLy8gRml4dXAgZW5jbG9zaW5nIHNjb3Blcy4gSGFwcGVucyBpbiBzaXR1YXRpb25zIGxpa2U6IGBzZXJ2ZXIub24gQCB3cmFwZXIgQCAoLi4uYXJncykgPT4gOjpgXG4gICAgY29uc3Qgc3RhY2sgPSBzdGF0ZS5vZmZzaWRlXG4gICAgZm9yIGxldCBpZHggPSBzdGFjay5sZW5ndGgtMTsgaWR4PjA7IGlkeC0tIDo6XG4gICAgICBsZXQgdGlwID0gc3RhY2tbaWR4XVxuICAgICAgaWYgdGlwLmxhc3QucG9zTGFzdENvbnRlbnQgPj0gbGFzdC5wb3NMYXN0Q29udGVudCA6OiBicmVha1xuICAgICAgdGlwLmxhc3QgPSBsYXN0XG5cbiAgcmV0dXJuIEB7fSBvcCwgaW5uZXJJbmRlbnQsIGZpcnN0LCBsYXN0XG4gICAgICBzdGFydDogc3RhdGUuc3RhcnQsIGVuZDogc3RhdGUuZW5kXG4gICAgICBsb2M6IEB7fSBzdGFydDogc3RhdGUuc3RhcnRMb2MsIGVuZDogc3RhdGUuZW5kTG9jXG5cblxuXG5wcC5maW5pc2hPZmZzaWRlT3AgPSBmdW5jdGlvbiAob3AsIGV4dHJhQ2hhcnMpIDo6XG4gIGNvbnN0IHN0YWNrID0gdGhpcy5zdGF0ZS5vZmZzaWRlXG4gIGxldCBzdGFja1RvcCA9IHN0YWNrW3N0YWNrLmxlbmd0aCAtIDFdXG4gIGxldCByZWNlbnRLZXl3b3JkVG9wXG4gIGlmIG9wLmNvZGVCbG9jayA6OlxuICAgIGlmIHN0YWNrVG9wICYmIHN0YWNrVG9wLmluS2V5d29yZEFyZyA6OlxuICAgICAgLy8gV2UncmUgYXQgdGhlIGVuZCBvZiBhbiBvZmZzaWRlIGtleXdvcmQgYmxvY2s7IHJlc3RvcmUgZW5jbG9zaW5nICgpXG4gICAgICB0aGlzLnBvcE9mZnNpZGUoKVxuICAgICAgdGhpcy5zdGF0ZS5vZmZzaWRlTmV4dE9wID0gb3BcbiAgICAgIHRoaXMuc3RhdGUub2Zmc2lkZVJlY2VudFRvcCA9IHN0YWNrVG9wXG4gICAgICByZXR1cm5cblxuICAgIHJlY2VudEtleXdvcmRUb3AgPSB0aGlzLnN0YXRlLm9mZnNpZGVSZWNlbnRUb3BcbiAgICB0aGlzLnN0YXRlLm9mZnNpZGVSZWNlbnRUb3AgPSBudWxsXG5cbiAgaWYgZXh0cmFDaGFycyA6OlxuICAgIHRoaXMuc3RhdGUucG9zICs9IGV4dHJhQ2hhcnNcblxuICB0aGlzLl9iYXNlX2ZpbmlzaFRva2VuKG9wLnRva2VuUHJlKVxuXG4gIGlmIHRoaXMuaXNMb29rYWhlYWQgOjogcmV0dXJuXG5cbiAgc3RhY2tUb3AgPSBzdGFja1tzdGFjay5sZW5ndGggLSAxXVxuICBjb25zdCBibGsgPSB0aGlzLm9mZnNpZGVCbG9jayhvcCwgc3RhY2tUb3AsIHJlY2VudEtleXdvcmRUb3ApXG4gIGJsay5pbktleXdvcmRBcmcgPSBvcC5pbktleXdvcmRBcmcgfHwgc3RhY2tUb3AgJiYgc3RhY2tUb3AuaW5LZXl3b3JkQXJnXG4gIHRoaXMuc3RhdGUub2Zmc2lkZS5wdXNoKGJsaylcblxuXG5wcC5fYmFzZV9za2lwU3BhY2UgPSBiYXNlUHJvdG8uc2tpcFNwYWNlXG5wcC5za2lwU3BhY2UgPSBmdW5jdGlvbigpIDo6XG4gIGNvbnN0IHN0YXRlID0gdGhpcy5zdGF0ZVxuICBpZiBudWxsICE9PSBzdGF0ZS5vZmZzaWRlTmV4dE9wIDo6IHJldHVyblxuXG4gIGNvbnN0IHN0YWNrID0gc3RhdGUub2Zmc2lkZVxuICBsZXQgc3RhY2tUb3BcbiAgaWYgc3RhY2sgJiYgc3RhY2subGVuZ3RoIDo6XG4gICAgc3RhY2tUb3AgPSBzdGFja1tzdGFjay5sZW5ndGgtMV1cbiAgICBzdGF0ZS5vZmZzaWRlUG9zID0gc3RhY2tUb3AubGFzdC5wb3NMYXN0Q29udGVudFxuICBlbHNlIDo6IHN0YXRlLm9mZnNpZGVQb3MgPSAtMVxuXG4gIHRyeSA6OlxuICAgIHRoaXMuX2Jhc2Vfc2tpcFNwYWNlKClcbiAgICBzdGF0ZS5vZmZzaWRlUG9zID0gLTFcblxuICAgIHN0YXRlLm9mZnNpZGVJbXBsaWNpdENvbW1hID0gdW5kZWZpbmVkICE9PSBzdGFja1RvcFxuICAgICAgPyB0aGlzLm9mZnNpZGVDaGVja0ltcGxpY2l0Q29tbWEoc3RhY2tUb3ApXG4gICAgICA6IG51bGxcbiAgY2F0Y2ggZXJyIDo6XG4gICAgaWYgZXJyICE9PSBvZmZzaWRlQnJlYWtvdXQgOjogdGhyb3cgZXJyXG5cblxuY29uc3QgdHRfb2Zmc2lkZV9kaXNydXB0X2ltcGxpY2l0X2NvbW1hID0gbmV3IFNldCBAI1xuICB0dC5jb21tYSwgdHQuZG90LCB0dC5hcnJvd1xuXG5wcC5vZmZzaWRlQ2hlY2tJbXBsaWNpdENvbW1hID0gZnVuY3Rpb24oc3RhY2tUb3ApIDo6XG4gIGlmICEgc3RhY2tUb3Aub3AuaW1wbGljaXRDb21tYXMgfHwgISB0aGlzLm9mZnNpZGVQbHVnaW5PcHRzLmltcGxpY2l0X2NvbW1hcyA6OlxuICAgIHJldHVybiBudWxsIC8vIG5vdCBlbmFibGVkIGZvciB0aGlzIG9mZnNpZGUgb3BcblxuICBjb25zdCBzdGF0ZSA9IHRoaXMuc3RhdGUsIHN0YXRlX3R5cGU9c3RhdGUudHlwZSwgY29sdW1uID0gc3RhdGUucG9zIC0gc3RhdGUubGluZVN0YXJ0XG4gIGlmIGNvbHVtbiAhPT0gc3RhY2tUb3AuaW5uZXJJbmRlbnQubGVuZ3RoIDo6XG4gICAgcmV0dXJuIG51bGwgLy8gbm90IGF0IHRoZSBleGFjdCByaWdodCBpbmRlbnRcbiAgaWYgc3RhY2tUb3AuZW5kID49IHN0YXRlLmVuZCA6OlxuICAgIHJldHVybiBmYWxzZSAvLyBubyBjb21tYSBiZWZvcmUgdGhlIGZpcnN0IGVsZW1lbnRcbiAgaWYgdHQuY29tbWEgPT09IHN0YXRlX3R5cGUgOjpcbiAgICByZXR1cm4gZmFsc2UgLy8gdGhlcmUncyBhbiBleHBsaWNpdCBjb21tYSBhbHJlYWR5IHByZXNlbnRcbiAgaWYgc3RhdGVfdHlwZS5iaW5vcCB8fCBzdGF0ZV90eXBlLmJlZm9yZUV4cHIgOjpcbiAgICByZXR1cm4gZmFsc2UgLy8gdGhlcmUncyBhbiBvcGVyYXRvciBvciBhcnJvdyBmdW5jdGlvbiBwcmVjZWVkaW5nIHRoaXMgbGluZVxuXG4gIGlmIHRoaXMuaXNMb29rYWhlYWQgOjogcmV0dXJuIGZhbHNlIC8vIGRpc2FsbG93IHJlY3Vyc2l2ZSBsb29rYWhlYWRcbiAgY29uc3Qge3R5cGU6IG5leHRfdHlwZX0gPSB0aGlzLmxvb2thaGVhZCgpXG4gIGlmIHR0X29mZnNpZGVfZGlzcnVwdF9pbXBsaWNpdF9jb21tYS5oYXMobmV4dF90eXBlKSB8fCBuZXh0X3R5cGUuYmlub3AgOjpcbiAgICByZXR1cm4gZmFsc2UgLy8gdGhlcmUncyBhIGNvbW1hLCBkb3QsIG9wZXJhdG9yLCBvciBvdGhlciB0b2tlbiB0aGF0IHByZWNsdWRlcyBhbiBpbXBsaWNpdCBsZWFkaW5nIGNvbW1hXG5cbiAgcmV0dXJuIHRydWUgLy8gYW4gaW1wbGljaXQgY29tbWEgaXMgbmVlZGVkXG5cbnBwLl9iYXNlX3JlYWRUb2tlbiA9IGJhc2VQcm90by5yZWFkVG9rZW5cbnBwLnJlYWRUb2tlbiA9IGZ1bmN0aW9uKGNvZGUpIDo6XG4gIGNvbnN0IHN0YXRlID0gdGhpcy5zdGF0ZVxuXG4gIGlmIHN0YXRlLm9mZnNpZGVJbXBsaWNpdENvbW1hIDo6XG4gICAgcmV0dXJuIHRoaXMuX2Jhc2VfZmluaXNoVG9rZW4odHQuY29tbWEpXG5cbiAgY29uc3Qgb2Zmc2lkZU5leHRPcCA9IHN0YXRlLm9mZnNpZGVOZXh0T3BcbiAgaWYgbnVsbCAhPT0gb2Zmc2lkZU5leHRPcCA6OlxuICAgIHN0YXRlLm9mZnNpZGVOZXh0T3AgPSBudWxsXG4gICAgcmV0dXJuIHRoaXMuZmluaXNoT2Zmc2lkZU9wKG9mZnNpZGVOZXh0T3ApXG5cbiAgaWYgc3RhdGUucG9zID09PSBzdGF0ZS5vZmZzaWRlUG9zIDo6XG4gICAgcmV0dXJuIHRoaXMucG9wT2Zmc2lkZSgpXG5cbiAgcmV0dXJuIHRoaXMuX2Jhc2VfcmVhZFRva2VuKGNvZGUpXG5cbnBwLnBvcE9mZnNpZGUgPSBmdW5jdGlvbigpIDo6XG4gIGNvbnN0IHN0YWNrID0gdGhpcy5zdGF0ZS5vZmZzaWRlXG4gIGNvbnN0IHN0YWNrVG9wID0gdGhpcy5pc0xvb2thaGVhZFxuICAgID8gc3RhY2tbc3RhY2subGVuZ3RoLTFdXG4gICAgOiBzdGFjay5wb3AoKVxuICB0aGlzLnN0YXRlLm9mZnNpZGVQb3MgPSAtMVxuXG4gIHRoaXMuX2Jhc2VfZmluaXNoVG9rZW4oc3RhY2tUb3Aub3AudG9rZW5Qb3N0KVxuICByZXR1cm4gc3RhY2tUb3BcblxuXG5yZXR1cm4gUGFyc2VyXG59IC8vIGVuZCBwZXItYmFieWxvbiBpbnN0YW5jZSBtb25rZXlwYXRjaGluZ1xuIl19