"""The shape of the public API: one exception base, and no module hidden by a name the package exports."""

import inspect
import pkgutil
import types

import deft_subspace.acp as acp
import deft_subspace.kernel as kernel
from deft_subspace.kernel import SubspaceError


def test_every_exported_exception_is_a_subspace_error():
    exported = [
        value
        for module in (kernel, acp)
        for name in module.__all__
        if inspect.isclass(value := getattr(module, name)) and issubclass(value, BaseException)
    ]
    assert len(exported) >= 14
    assert [e.__name__ for e in exported if not issubclass(e, SubspaceError)] == []


def test_encode_error_is_still_a_value_error():
    assert issubclass(kernel.EncodeError, ValueError)


def test_no_public_module_is_hidden_by_an_exported_name():
    # `deft_subspace.acp.start` was the function, so the module of the same name could not be reached.
    hidden = [
        f"{package.__name__}.{info.name}"
        for package in (kernel, acp)
        for info in pkgutil.iter_modules(package.__path__)
        if not isinstance(getattr(package, info.name, types), types.ModuleType)
    ]
    assert hidden == []


def test_what_the_private_modules_define_is_exported_by_the_package():
    # Their names are reachable only through `deft_subspace.acp`, so each public one must be there.
    # (`_util` is helpers, not API.)
    import importlib

    missing = [
        f"{name_of_module}.{name}"
        for name_of_module in ("_start", "_conveniences", "_mcp_connector", "_model_agent")
        for module in [importlib.import_module(f"{acp.__name__}.{name_of_module}")]
        for name, value in vars(module).items()
        if not name.startswith("_") and (inspect.isclass(value) or inspect.isfunction(value)) and value.__module__ == module.__name__
        if name not in acp.__all__
    ]
    assert missing == []
