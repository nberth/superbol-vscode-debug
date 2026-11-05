import * as assert from 'assert';
import * as nativePath from "path";
import { SourceMap } from '../../src/parser.c';

suite("C code parse", () => {
	const cwd = nativePath.resolve(__dirname, '../../../test/resources');
	test("Minimal", () => {
		const c = nativePath.resolve(cwd, 'hello.c');
		const cobol = nativePath.resolve(cwd, 'hello.cbl');
		const parsed = new SourceMap(cwd, [cobol]);

		assert.equal(3, parsed.getLinesCount());
		assert.equal(3, parsed.getVariablesCount());
		assert.equal('b_6', parsed.getVariableByCobol('hello_.MYVAR').cName);
		assert.equal('f_6', parsed.getVariableByCobol('hello_.MYVAR.MYVAR').cName);
		assert.equal('hello_', parsed.getVariableByCobol('hello_.MYVAR').functionName);
		assert.equal('MYVAR', parsed.getVariableByC('hello_.b_6').cobolName);
		assert.equal('MYVAR', parsed.getVariableByC('hello_.f_6').cobolName);
		assert.equal(105, parsed.getLineC(cobol, 8).lineC);
		assert.equal(c, parsed.getLineC(cobol, 8).fileC);
		assert.equal(8, parsed.getLineCobol(c, 105).lineCobol);
		assert.equal(cobol, parsed.getLineCobol(c, 105).fileCobol);

		assert.equal('2.2.0', parsed.getVersion());
	});
	test("GnuCOBOL 3.1.1", () => {
		const c = nativePath.resolve(cwd, 'hello3.c');
		const cobol = nativePath.resolve(cwd, 'hello3.cbl');
		const parsed = new SourceMap(cwd, [cobol]);

		assert.equal(3, parsed.getLinesCount());
		assert.equal(3, parsed.getVariablesCount());
		assert.equal('b_8', parsed.getVariableByCobol('hello3_.MYVAR').cName);
		assert.equal('f_8', parsed.getVariableByCobol('hello3_.MYVAR.MYVAR').cName);
		assert.equal('MYVAR', parsed.getVariableByC('hello3_.b_8').cobolName);
		assert.equal('MYVAR', parsed.getVariableByC('hello3_.f_8').cobolName);

		assert.equal(7, parsed.getLineCobol(c, 116).lineCobol);
		assert.equal(8, parsed.getLineCobol(c, 123).lineCobol);
		assert.equal(9, parsed.getLineCobol(c, 130).lineCobol);
		assert.equal(116, parsed.getLineC(cobol, 7).lineC);
		assert.equal(123, parsed.getLineC(cobol, 8).lineC);
		assert.equal(130, parsed.getLineC(cobol, 9).lineC);

		assert.equal('3.1.1.0', parsed.getVersion());
	});
	test("Compilation Group", () => {
		const parsed = new SourceMap(cwd, ['sample.cbl', 'subsample.cbl', 'subsubsample.cbl']);

		assert.equal(7, parsed.getLinesCount());
		assert.equal(14, parsed.getVariablesCount());

		assert.equal('b_11', parsed.getVariableByCobol('sample_.WS-GROUP').cName);
		assert.equal('f_11', parsed.getVariableByCobol('sample_.WS-GROUP.WS-GROUP').cName);
		assert.equal('f_6', parsed.getVariableByCobol('subsample_.WS-GROUP').cName);
		assert.equal('f_11', parsed.getVariableByCobol('subsubsample_.WS-GROUP-ALPHANUMERIC').cName);

		assert.equal('WS-GROUP', parsed.getVariableByC('sample_.f_11').cobolName);
		assert.equal('WS-GROUP', parsed.getVariableByC('subsample_.f_6').cobolName);
		assert.equal('WS-GROUP-ALPHANUMERIC', parsed.getVariableByC('subsubsample_.f_11').cobolName);

		assert.equal('2.2.0', parsed.getVersion());
	});
	test("Variables Hierarchy", () => {
		const parsed = new SourceMap(cwd, ['petstore.cbl']);

		assert.equal('b_14', parsed.getVariableByCobol('petstore_.WS-BILL').cName);
		assert.equal('f_15', parsed.getVariableByCobol('petstore_.WS-BILL.TOTAL-QUANTITY').cName);
		assert.equal('WS-BILL', parsed.getVariableByC('petstore_.b_14').cobolName);
		assert.equal('TOTAL-QUANTITY', parsed.getVariableByC('petstore_.f_15').cobolName);
	});
	test("Find variables by function and COBOL name", () => {
		const parsed = new SourceMap(cwd, ['petstore.cbl']);

		assert.equal('f_15', parsed.findVariableByCobol('petstore_', 'TOTAL-QUANTITY').cName);
		assert.equal('f_15', parsed.findVariableByCobol('petstore_', 'WS-BILL.TOTAL-QUANTITY').cName);
		assert.equal(null, parsed.findVariableByCobol('petstore_', 'BLABLABLA'));
		assert.equal(null, parsed.findVariableByCobol('blablaba_', 'WS-BILL.TOTAL-QUANTITY'));

		assert.equal('3.1-dev.0', parsed.getVersion());
	});
	test("Attributes", () => {
		const parsed = new SourceMap(cwd, ['datatypes.cbl']);

		for (let variable of parsed.getVariablesByCobol()) {
			assert.notEqual(variable.attribute, null);
			assert.notEqual(variable.attribute, undefined);
			assert.notEqual(variable.attribute.type, null);
			assert.notEqual(variable.attribute.type, undefined);
			assert.notEqual(variable.attribute.digits, null);
			assert.notEqual(variable.attribute.digits, undefined);
			assert.notEqual(variable.attribute.scale, null);
			assert.notEqual(variable.attribute.scale, undefined);
			assert.notEqual(variable.attribute.flags, undefined);
		}

		const variable = parsed.getVariableByCobol('datatypes_.NUMERIC-DATA.DISPP');
		assert.equal('numeric', variable.attribute.type);
		assert.equal(8, variable.attribute.digits);
		assert.equal(8, variable.attribute.scale);

		assert.equal('3.1-dev.0', parsed.getVersion());
	});
	test("Multiple Functions", () => {
		const parsed = new SourceMap(cwd, ['func.cbl']);

		const f_6 = parsed.getVariableByC('func_.f_6');
		assert.equal('argA', f_6.cobolName);

		const f_14 = parsed.getVariableByC('dvd_.f_14');
		assert.equal('dividend', f_14.cobolName);

		const f_23 = parsed.getVariableByC('mlp_.f_23');
		assert.equal('argA', f_23.cobolName);

		const argADataStorageFunc = parsed.getVariableByCobol('func_.ARGA');
		assert.equal('b_6', argADataStorageFunc.cName);

		const argAFunc = parsed.getVariableByCobol('func_.ARGA.ARGA');
		assert.equal('f_6', argAFunc.cName);

		const dividendDvd = parsed.getVariableByCobol('dvd_.DIVIDEND');
		assert.equal('f_14', dividendDvd.cName);

		const argAMlp = parsed.getVariableByCobol('mlp_.ARGA');
		assert.equal('f_23', argAMlp.cName);

		assert.equal('2.2.0', parsed.getVersion());
	});
	test("Split Sources", () => {
		const srcDirs = nativePath.resolve(cwd, 'distinct-sources');
		const cDirs = nativePath.resolve(srcDirs, 'c');
		const cblDirs = nativePath.resolve(srcDirs, 'cbl');
		const parsed = new SourceMap(cwd, ['subsubsample.cbl'], [cDirs, cblDirs]);

		assert.equal(1, parsed.getLinesCount());
		assert.equal(3, parsed.getVariablesCount());

		const alnumGroup = parsed.findVariableByCobol('subsubsample_', 'WS-GROUP-ALPHANUMERIC');
		assert.equal('WS-GROUP-ALPHANUMERIC', alnumGroup.cobolName);

		const alnumGroup_ = parsed.findVariableByC('subsubsample_', alnumGroup.cName);
		assert.equal(alnumGroup_.cobolName, alnumGroup.cobolName);
		assert.equal(alnumGroup_.rootFileC, alnumGroup.rootFileC);
	});
	test("Globals", () => {
		const parsed = new SourceMap(cwd, ['globals.cbl']);
		assert.equal(9, parsed.getLinesCount());
		assert.equal(11, parsed.getVariablesCount());
		
		const fooVar = parsed.findGlobalByCobol('FOO');
		assert.ok(fooVar.cobolName.endsWith('FOO'));
		assert.ok(parsed.findGlobalByC(fooVar.cName).cobolName.endsWith('FOO'));
		const barVar = parsed.findGlobalByCobol('BAR');
		assert.equal(4, barVar.size);
		const bar1Var = parsed.findGlobalByCobol('BAR.BAR-2');
		assert.equal(3, bar1Var.size);
		assert.equal('alphanumeric', bar1Var.displayableType);

		parsed.addLib('globals2.so');
		assert.equal(12, parsed.getLinesCount());
		assert.equal(14, parsed.getVariablesCount());

		const fooVar_ = parsed.findGlobalByCobol('FOO');
		assert.ok(parsed.findGlobalByC(fooVar_.cName).cobolName.endsWith('FOO'));
		assert.notEqual(parsed.findGlobalByCobol('FOO', nativePath.join(cwd, 'globals.c.h')),
						parsed.findGlobalByCobol('FOO', nativePath.join(cwd, 'globals2.c.h')));
		assert.equal(parsed.findGlobalByCobol('FOO', nativePath.join(cwd, 'globals2.c.h')),
					 parsed.findGlobalByCobol('foo', nativePath.join(cwd, 'globals2.c.h')));
		assert.ok(parsed.findGlobalByCobol('BAR-2', nativePath.join(cwd, 'globals.c.h')));
	});
	test("GnuCOBOL 3.3 PERFORM statements", () => {
		const c = nativePath.resolve(cwd, 'performs.c');
		const cobol = nativePath.resolve(cwd, 'performs.cbl');
		const parsed = new SourceMap(cwd, [cobol]);

		// The code of PERFORM statements starts with a comment, on which gdb
		// never stops: they map to the first line with code (`frame_ptr++`).
		assert.equal(123, parsed.getLineC(cobol, 10).lineC);
		assert.equal(10, parsed.getLineCobol(c, 123).lineCobol);
		// `PERFORM ... TIMES` maps to its loop header.
		assert.equal(136, parsed.getLineC(cobol, 11).lineC);
		// The last statement of the procedure division keeps its own line,
		// despite the `#line` directives that follow in the initialization
		// code.
		assert.equal(255, parsed.getLineC(cobol, 23).lineC);
		assert.equal(23, parsed.getLineCobol(c, 255).lineCobol);

		assert.equal('3.3-dev.0', parsed.getVersion());
	});
});
