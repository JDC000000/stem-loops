"""worker.chord_providers — concrete ChordSource implementations.

Nothing in here is imported directly by the pipeline. Only
``worker.chord_source.get_chord_source()`` dispatches here, so adding a new
provider is a single-file add + one branch in the factory.
"""
