// blue_telep2 is used in oa_ctf4ish
textures/ctf/blue_telep2
{
	q3map_lightimage textures/ctf/blue_telep
	surfaceparm noimpact
	surfaceparm nolightmap
	surfaceparm nomarks
	surfaceparm trans
	cull disable
	q3map_surfacelight 455
	{
		clampmap textures/ctf/blue_telep
		blendfunc add
		tcMod rotate 40
	}
	{
		clampmap textures/ctf/blue_telep2.jpg
		blendfunc add
		tcMod stretch sin 0.6 -0.3 0 0.5
		tcMod rotate -80
	}
	{
		clampmap textures/ctf/blue_telep2.jpg
		blendfunc add
		tcMod stretch sin 0.5 0.3 0 0.5
		tcMod rotate -80
	}
}

// blue_telep2 is used in oa_ctf4ish
textures/ctf/red_telep2
{
	q3map_lightimage textures/ctf/red_telep
	surfaceparm noimpact
	surfaceparm nolightmap
	surfaceparm nomarks
	surfaceparm trans
	cull disable
	q3map_surfacelight 455
	{
		clampmap textures/ctf/red_telep
		blendfunc add
		tcMod rotate 40
	}
	{
		clampmap textures/ctf/red_telep2.jpg
		blendfunc add
		tcMod stretch sin 0.6 -0.3 0 0.5
		tcMod rotate -80
	}
	{
		clampmap textures/ctf/red_telep2.jpg
		blendfunc add
		tcMod stretch sin 0.5 0.3 0 0.5
		tcMod rotate -80
	}
}