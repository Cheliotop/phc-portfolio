/**
 * The Ficha's step checks must read a decimal comma the way submission does.
 * Number("10,5") is NaN, and a NaN comparison is false, so the "dynamic level
 * must exceed static" and "maximum flow below pumped flow" rules used to pass
 * silently for a value typed with a comma.
 */
import { fichaStepBlockers } from '../src/components/operator/FichaTecnicaTab';

const base = {
  staticLevel: '', dynamicLevel: '', flowRate: '', maximumFlow: '',
  pumpDepth: '', explorationDepth: '', wideningDepth: '',
};

describe('Ficha step checks with a decimal comma (OPB-12)', () => {
  it('still refuses a dynamic level that is not below the static level', () => {
    const blockers = fichaStepBlockers('hidraulicos', {
      ...base, staticLevel: '10,5', dynamicLevel: '9', flowRate: '3', maximumFlow: '4', pumpDepth: '20',
    });
    expect(blockers).toEqual(['El nivel dinámico debe ser mayor que el estático']);
  });

  it('refuses a dynamic level equal to the static level written with a comma', () => {
    const blockers = fichaStepBlockers('hidraulicos', {
      ...base, staticLevel: '10,5', dynamicLevel: '10,5', flowRate: '3', maximumFlow: '4', pumpDepth: '20',
    });
    expect(blockers).toEqual(['El nivel dinámico debe ser mayor que el estático']);
  });

  it('refuses a maximum flow below the pumped flow written with a comma', () => {
    const blockers = fichaStepBlockers('hidraulicos', {
      ...base, staticLevel: '10', dynamicLevel: '12,5', flowRate: '4,5', maximumFlow: '4,0', pumpDepth: '20',
    });
    expect(blockers).toEqual(['El caudal máximo no puede ser menor que el bombeado']);
  });

  it('passes a correct set of values written with commas', () => {
    expect(fichaStepBlockers('hidraulicos', {
      ...base, staticLevel: '10,5', dynamicLevel: '12,5', flowRate: '3,2', maximumFlow: '4,0', pumpDepth: '20',
    })).toEqual([]);
  });
});
