"""Bridge Paddle's single-element float conversion on strict NumPy releases."""
from functools import wraps
from math import prod


def install_tensor_float_compatibility(paddle_module=None):
    if paddle_module is None:
        import paddle as paddle_module
    tensor_type = paddle_module.Tensor
    original = tensor_type.__float__
    if getattr(original, '_collector_scalar_compatibility', False):
        return False
    probe = paddle_module.to_tensor([0.25], dtype='float32', place=paddle_module.CPUPlace())
    try:
        float(probe)
        return False
    except TypeError as error:
        if 'only 0-dimensional arrays can be converted to Python scalars' not in str(error):
            raise

    @wraps(original)
    def scalar_float(tensor):
        if prod(tensor.shape) != 1 or not tensor._is_initialized():
            return original(tensor)
        if tensor.dtype == paddle_module.bfloat16:
            tensor = tensor.astype('float32')
        return float(tensor.item())

    scalar_float._collector_scalar_compatibility = True
    tensor_type.__float__ = scalar_float
    return True
