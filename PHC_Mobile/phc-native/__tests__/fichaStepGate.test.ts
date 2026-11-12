/**
 * Ficha step-gate rules.
 *
 * The Ficha asks for 26 fields. It used to ask for all of them at once and
 * validate on submit, so an error made in the second field surfaced after the
 * twenty-sixth — by which point the operator is at a well, in the sun, and has
 * to work out which of 26 values was wrong.
 *
 * The step flow moves each check to the moment the value is entered. This
 * covers the rules themselves, which is the part that has to stay correct: the
 * screen can be rearranged freely, but "the dynamic level must exceed the
 * static level" is physics and must never be advanceable past.
 *
 * Mirrors `missingForStep` in FichaTecnicaTab.
 */
type Step = 'evidencia' | 'hidraulicos' | 'entubado' | 'firma';

interface Draft {
  staticLevel: string;
  dynamicLevel: string;
  flowRate: string;
  maximumFlow: string;
  pumpDepth: string;
  explorationDepth: string;
  wideningDepth: string;
}

const EMPTY: Draft = {
  staticLevel: '', dynamicLevel: '', flowRate: '',
  maximumFlow: '', pumpDepth: '', explorationDepth: '', wideningDepth: '',
};

function missingForStep(step: Step, draft: Draft): string[] {
  const number = (value: string) => (value.trim() === '' ? null : Number(value));
  const needs = (value: string, label: string) => {
    const parsed = number(value);
    if (parsed == null || Number.isNaN(parsed) || parsed < 0) return label;
    return null;
  };
  if (step === 'hidraulicos') {
    const list = [
      needs(draft.staticLevel, 'Nivel estático'),
      needs(draft.dynamicLevel, 'Nivel dinámico'),
      needs(draft.flowRate, 'Caudal bombeado'),
      needs(draft.maximumFlow, 'Caudal máximo'),
      needs(draft.pumpDepth, 'Profundidad de bomba'),
    ].filter((entry): entry is string => entry !== null);
    if (list.length === 0 && Number(draft.dynamicLevel) <= Number(draft.staticLevel)) {
      list.push('El nivel dinámico debe ser mayor que el estático');
    }
    if (list.length === 0 && Number(draft.maximumFlow) < Number(draft.flowRate)) {
      list.push('El caudal máximo no puede ser menor que el bombeado');
    }
    return list;
  }
  if (step === 'entubado') {
    return [
      needs(draft.explorationDepth, 'Profundidad de exploración'),
      needs(draft.wideningDepth, 'Profundidad de ensanche'),
    ].filter((entry): entry is string => entry !== null);
  }
  return [];
}

const valid: Draft = {
  staticLevel: '10', dynamicLevel: '18', flowRate: '2000',
  maximumFlow: '2500', pumpDepth: '40', explorationDepth: '60', wideningDepth: '55',
};

describe('Ficha step gate', () => {
  it('lets the review step through without data entry', () => {
    expect(missingForStep('evidencia', EMPTY)).toEqual([]);
  });

  it('names every missing hydraulic field rather than just refusing', () => {
    const missing = missingForStep('hidraulicos', EMPTY);
    expect(missing).toEqual([
      'Nivel estático', 'Nivel dinámico', 'Caudal bombeado',
      'Caudal máximo', 'Profundidad de bomba',
    ]);
  });

  it('blocks a dynamic level below the static level', () => {
    // Physically impossible: pumping cannot raise the water level.
    const missing = missingForStep('hidraulicos', { ...valid, dynamicLevel: '5' });
    expect(missing).toEqual(['El nivel dinámico debe ser mayor que el estático']);
  });

  it('blocks equal static and dynamic levels, which would divide by zero', () => {
    const missing = missingForStep('hidraulicos', { ...valid, dynamicLevel: '10' });
    expect(missing).toHaveLength(1);
  });

  it('blocks a maximum flow below the pumped flow', () => {
    const missing = missingForStep('hidraulicos', { ...valid, maximumFlow: '100' });
    expect(missing).toEqual(['El caudal máximo no puede ser menor que el bombeado']);
  });

  it('rejects text and negatives where a measurement is required', () => {
    expect(missingForStep('hidraulicos', { ...valid, flowRate: 'abc' })).toContain('Caudal bombeado');
    expect(missingForStep('hidraulicos', { ...valid, pumpDepth: '-5' })).toContain('Profundidad de bomba');
  });

  it('passes a complete, physically coherent hydraulic step', () => {
    expect(missingForStep('hidraulicos', valid)).toEqual([]);
  });

  it('requires both depths before the casing step advances', () => {
    expect(missingForStep('entubado', EMPTY)).toEqual([
      'Profundidad de exploración', 'Profundidad de ensanche',
    ]);
    expect(missingForStep('entubado', valid)).toEqual([]);
  });
});
