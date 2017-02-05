import * as _ from 'lodash';
import { MathUtil, Point, Matrix, Rect, SvgUtil } from '../common';
import { PathHelper, newPathHelper } from './pathhelper';
import { PathCommand, SubPathCommand, Command, SvgChar, Projection } from '.';
import { PathParser } from '../parsers';
import { newSubPathCommand } from './SubPathCommandImpl';
import {
  CommandImpl, newMove, newLine, newQuadraticCurve, newBezierCurve, newArc, newClosePath
} from './CommandImpl';

/**
 * Contains additional information about each individual command so that we can
 * remember how they should be projected onto and split/unsplit/converted at runtime.
 * PathCommands are immutable, stateless objects that depend on CommandWrappers to
 * remember their mutations. CommandWrappers themselves are also immutable to ensure that
 * each PathCommand maintains its own unique snapshot of its current mutation state.
 */
export class CommandMutation {
  readonly backingCommand: CommandImpl;

  // Note that the path helper is undefined for move commands.
  private readonly pathHelper: PathHelper;

  // A command wrapper wraps around the initial SVG command and outputs
  // a list of transformed commands resulting from splits, unsplits,
  // conversions, etc. If the initial SVG command hasn't been modified,
  // then a list containing the initial SVG command is returned.
  private readonly drawCommands: ReadonlyArray<CommandImpl>;

  // The list of mutations describes how the initial backing command
  // has since been modified. Since the command wrapper always holds a
  // reference to its initial backing command, these modifications
  // are always reversible.
  private readonly mutations: ReadonlyArray<Mutation>;

  constructor(obj: CommandImpl | CommandWrapperParams) {
    if (obj instanceof CommandImpl) {
      this.backingCommand = obj;
      this.mutations = [{
        id: _.uniqueId(),
        t: 1,
        svgChar: this.backingCommand.svgChar,
      }];
      this.drawCommands = [obj];
    } else {
      this.backingCommand = obj.backingCommand;
      this.mutations = obj.mutations;
      this.drawCommands = obj.drawCommands;
    }
    this.pathHelper = newPathHelper(this.backingCommand);
  }

  private clone(params: CommandWrapperParams = {}) {
    return new CommandMutation(_.assign({}, {
      backingCommand: this.backingCommand,
      mutations: this.mutations.slice(),
      drawCommands: this.drawCommands.slice(),
    }, params));
  }

  pathLength() {
    const isMove = this.backingCommand.svgChar === 'M';
    return isMove ? 0 : this.pathHelper.pathLength();
  }

  /**
   * Note that the projection is performed in relation to the command wrapper's
   * original backing command.
   */
  project(point: Point): Projection | undefined {
    const isMove = this.backingCommand.svgChar === 'M';
    return isMove ? undefined : this.pathHelper.project(point);
  }

  /**
   * Note that the split is performed in relation to the command wrapper's
   * original backing command.
   */
  split(ts: number[]) {
    // TODO: add a test for splitting a command with a path length of 0
    // TODO: add a test for the case when t === 1
    if (!ts.length || this.backingCommand.svgChar === 'M') {
      return this;
    }
    const currSplits = this.mutations.map(m => m.t);
    const currSvgChars = this.mutations.map(m => m.svgChar);
    const updatedMutations = this.mutations.slice();
    for (const t of ts) {
      const currIdx = _.sortedIndex(currSplits, t);
      const id = _.uniqueId();
      // TODO: what about if the last command is a Z? then we want the svg char to be L!!
      const svgChar = currSvgChars[currIdx];
      const mutation = { id, t, svgChar };
      const insertionIdx =
        _.sortedIndexBy<Mutation>(updatedMutations, mutation, m => m.t);
      updatedMutations.splice(insertionIdx, 0, { id, t, svgChar });
    }
    return this.rebuildCommands(updatedMutations);
  }

  /**
   * Each command is given a globally unique ID (to improve performance
   * inside *ngFor loops, etc.).
   */
  getIdAtIndex(splitIdx: number) {
    return this.mutations[splitIdx].id;
  }

  /**
   * Inserts the provided t values at the specified split index. The t values
   * are linearly interpolated between the split values at splitIdx and
   * splitIdx + 1 to ensure the split is done in relation to the mutated command.
   */
  splitAtIndex(splitIdx: number, ts: number[]) {
    const tempSplits = [0, ...this.mutations.map(m => m.t)];
    const startSplit = tempSplits[splitIdx];
    const endSplit = tempSplits[splitIdx + 1];
    return this.split(ts.map(t => MathUtil.lerp(startSplit, endSplit, t)));
  }

  /**
   * Same as splitAtIndex() except the command is split into two approximately
   * equal parts.
   */
  splitInHalfAtIndex(splitIdx: number) {
    const tempSplits = [0, ...this.mutations.map(m => m.t)];
    const startSplit = tempSplits[splitIdx];
    const endSplit = tempSplits[splitIdx + 1];
    const distance = MathUtil.lerp(startSplit, endSplit, 0.5);
    return this.split([this.pathHelper.findTimeByDistance(distance)]);
  }

  /**
   * Unsplits the command at the specified split index.
   */
  unsplitAtIndex(splitIdx: number) {
    const mutations = this.mutations.slice();
    mutations.splice(splitIdx, 1);
    return this.rebuildCommands(mutations);
  }

  /**
   * Converts the command at the specified split index.
   */
  convertAtIndex(splitIdx: number, svgChar: SvgChar) {
    const mutations = this.mutations.slice();
    mutations[splitIdx] = _.assign({}, mutations[splitIdx], { svgChar });
    return this.rebuildCommands(mutations);
  }

  // TODO: this could be more efficient (avoid recreating commands unnecessarily)
  private rebuildCommands(mutations: Mutation[]) {
    if (mutations.length === 1) {
      const command = this.pathHelper.convert(mutations[0].svgChar).toCommand(false);
      return this.clone({ mutations, drawCommands: [command] as CommandImpl[] });
    }
    const commands = [];
    let prevT = 0;
    for (let i = 0; i < mutations.length; i++) {
      const currT = mutations[i].t;
      const isSplit = i !== mutations.length - 1;
      commands.push(
        this.pathHelper.split(prevT, currT)
          .convert(mutations[i].svgChar)
          .toCommand(isSplit));
      prevT = currT;
    }
    return this.clone({ mutations, drawCommands: commands });
  }

  get commands() {
    return this.drawCommands;
  }
}

interface Mutation {
  readonly id: string;
  readonly t: number;
  readonly svgChar: SvgChar;
}

/**
 * Command wrapper internals that have been cloned.
 */
interface CommandWrapperParams {
  backingCommand?: CommandImpl;
  mutations?: ReadonlyArray<Mutation>;
  drawCommands?: ReadonlyArray<CommandImpl>;
}