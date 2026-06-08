type MachineDefinition = {
  initialState: string;
  states: Record<string, Record<string, string>>;
};

type MachineState<Definition extends MachineDefinition> = keyof Definition["states"] & string;

type MachineEvent<Definition extends MachineDefinition> = {
  [State in keyof Definition["states"]]: keyof Definition["states"][State];
}[keyof Definition["states"]] &
  string;

export function createMachine<const Definition extends MachineDefinition>(
  definition: Definition
) {
  let value = definition.initialState as MachineState<Definition>;

  return {
    get value(): MachineState<Definition> {
      return value;
    },
    transition(event: MachineEvent<Definition>): MachineState<Definition> {
      const nextState = definition.states[value][event];
      if (!nextState) {
        throw new Error(`invalid state transition: ${value} -> ${event}`);
      }
      value = nextState as MachineState<Definition>;
      return value;
    },
  };
}
