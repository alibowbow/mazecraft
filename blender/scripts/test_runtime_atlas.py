"""Check loop value/slope continuity for every procedural tile, without Blender."""
import math
import unittest
from bake_runtime_atlas import surface

class AtlasLoopTest(unittest.TestCase):
    def test_periodic_values_and_slopes(self):
        epsilon = 1e-5
        for tile in range(8):
            for x, y in [(-.8, -.7), (0, 0), (.6, -.3), (.9, .8)]:
                start = surface(tile, x, y, 0, 2747636419)
                end = surface(tile, x, y, math.tau, 2747636419)
                before = surface(tile, x, y, math.tau - epsilon, 2747636419)
                after = surface(tile, x, y, epsilon, 2747636419)
                for channel in range(2):
                    self.assertAlmostEqual(start[channel], end[channel], places=10)
                    self.assertAlmostEqual((start[channel] - before[channel]) / epsilon,
                                           (after[channel] - start[channel]) / epsilon,
                                           delta=.002)

if __name__ == '__main__':
    unittest.main()
