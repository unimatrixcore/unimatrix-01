import json
import os
from types import SimpleNamespace
import unittest

from tensor_scalar_compatibility import install_tensor_float_compatibility


def fake_paddle(broken=True, error_message='only 0-dimensional arrays can be converted to Python scalars'):
    class Tensor:
        def __init__(self, value=.25, shape=(1,), dtype='float32', initialized=True):
            self.value, self.shape, self.dtype = value, shape, dtype
            self.initialized = initialized
            self.item_calls = 0
            self.casts = []

        def __float__(self):
            if self.shape not in ((), (1,), (1, 1)):
                raise AssertionError('only one element variable can be converted to float')
            if not self.initialized:
                raise AssertionError("variable's tensor is not initialized")
            if broken:
                raise TypeError(error_message)
            return float(self.item())

        def _is_initialized(self):
            return self.initialized

        def item(self):
            self.item_calls += 1
            return self.value

        def astype(self, dtype):
            self.casts.append(dtype)
            return Tensor(self.value, self.shape, dtype)

    return SimpleNamespace(Tensor=Tensor, to_tensor=lambda *args, **kwargs: Tensor(),
                           CPUPlace=lambda: 'cpu', bfloat16='bfloat16')


class TensorFloatCompatibilityTest(unittest.TestCase):
    def test_scalar_and_single_element_shapes_use_item(self):
        paddle = fake_paddle()
        self.assertTrue(install_tensor_float_compatibility(paddle))
        for shape in ((), (1,), (1, 1)):
            tensor = paddle.Tensor(.25, shape=shape)
            self.assertEqual(float(tensor), .25)
            self.assertEqual(tensor.item_calls, 1)
        self.assertFalse(install_tensor_float_compatibility(paddle))

    def test_non_scalar_and_uninitialized_tensor_guards_remain(self):
        paddle = fake_paddle()
        install_tensor_float_compatibility(paddle)
        for shape in ((2,), (1, 2), (0,)):
            tensor = paddle.Tensor(shape=shape)
            with self.assertRaisesRegex(AssertionError, 'only one element'):
                float(tensor)
            self.assertEqual(tensor.item_calls, 0)
        with self.assertRaisesRegex(AssertionError, 'not initialized'):
            float(paddle.Tensor(initialized=False))

    def test_bfloat16_retains_float32_conversion(self):
        paddle = fake_paddle()
        install_tensor_float_compatibility(paddle)
        tensor = paddle.Tensor(dtype='bfloat16')
        self.assertEqual(float(tensor), .25)
        self.assertEqual(tensor.casts, ['float32'])

    def test_working_upstream_implementation_is_unchanged(self):
        paddle = fake_paddle(broken=False)
        original = paddle.Tensor.__float__
        self.assertFalse(install_tensor_float_compatibility(paddle))
        self.assertIs(paddle.Tensor.__float__, original)

    def test_unrelated_probe_error_is_not_masked(self):
        paddle = fake_paddle(error_message='unexpected tensor failure')
        original = paddle.Tensor.__float__
        with self.assertRaisesRegex(TypeError, 'unexpected tensor failure'):
            install_tensor_float_compatibility(paddle)
        self.assertIs(paddle.Tensor.__float__, original)


@unittest.skipUnless(os.environ.get('POKER_TEST_CUDA') == '1', 'Explicit CUDA regression run required')
class GradScalerCudaRegressionTest(unittest.TestCase):
    def test_overflow_skips_update_decreases_scale_and_finite_steps_recover(self):
        import paddle
        import numpy as np
        paddle.set_device('gpu:0')
        self.assertGreater(paddle.device.cuda.device_count(), 0)

        def setup():
            parameter = paddle.create_parameter([1], 'float32',
                                                default_initializer=paddle.nn.initializer.Constant(1.))
            optimizer = paddle.optimizer.SGD(learning_rate=.1, parameters=[parameter])
            scaler = paddle.amp.GradScaler(init_loss_scaling=1024., incr_every_n_steps=2,
                                          decr_every_n_nan_or_inf=1, decr_ratio=.5,
                                          use_dynamic_loss_scaling=True)
            self.assertTrue(scaler._enable)
            self.assertTrue(scaler._use_dynamic_loss_scaling)
            return parameter, optimizer, scaler

        def step(parameter, optimizer, scaler, overflow=False):
            with paddle.amp.auto_cast(enable=True):
                loss = (parameter * float('inf')).sum() if overflow else parameter.square().sum()
            scaled = scaler.scale(loss)
            scaled.backward()
            scaler.minimize(optimizer, scaled)
            optimizer.clear_grad()

        reproduced = False
        try:
            float(paddle.to_tensor([1024.], dtype='float32'))
        except TypeError as error:
            if 'only 0-dimensional arrays can be converted to Python scalars' not in str(error):
                raise
            parameter, optimizer, scaler = setup()
            with self.assertRaisesRegex(TypeError, 'only 0-dimensional arrays'):
                step(parameter, optimizer, scaler, overflow=True)
            self.assertEqual(parameter.item(), 1.)
            reproduced = True

        applied = install_tensor_float_compatibility(paddle)
        self.assertEqual(applied, reproduced)
        parameter, optimizer, scaler = setup()
        step(parameter, optimizer, scaler, overflow=True)
        self.assertEqual(parameter.item(), 1.)
        self.assertEqual(scaler._scale.item(), 512.)
        step(parameter, optimizer, scaler)
        self.assertAlmostEqual(parameter.item(), .8, places=6)
        self.assertEqual(scaler._scale.item(), 512.)
        step(parameter, optimizer, scaler)
        self.assertAlmostEqual(parameter.item(), .64, places=6)
        self.assertEqual(scaler._scale.item(), 1024.)
        print(json.dumps({'paddle': paddle.__version__, 'numpy': np.__version__,
                          'device': paddle.get_device(), 'reproduced_before_fix': reproduced,
                          'overflow_parameter_unchanged': True, 'overflow_scale': 512.,
                          'finite_parameter': parameter.item(), 'recovered_scale': scaler._scale.item()}), flush=True)


if __name__ == '__main__':
    unittest.main()
